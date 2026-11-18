import { Download, LoaderCircle, MessagesSquare, Plus, PlugZap, RefreshCw, Send, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  askAiaPeer,
  checkAiaPeer,
  getAiaPeerExchange,
  getAiaPeers,
  importAiaPeerSkill,
  listAiaPeerExchanges,
  listAiaPeerSkills,
  removeAiaPeer,
  setAiaPeer,
  setAiaPeerAgentEnabled,
  setAiaPeerPolicy,
} from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type {
  AiaPeerCheckReceipt,
  AiaPeerExchangeView,
  AiaPeerPolicy,
  AiaPeerSkillState,
  AiaPeerSkillsView,
  AiaPeersSnapshot,
  AiaPeerView,
} from "../types";
import { AppToggle, ErrorBanner, useBusyAction, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";
import { createLatestGate } from "../lib/latestRequest";
import { formatRelative } from "../lib/format";

/** 같은 기기의 새 AIA 에게 묻는 피어 id. 백엔드 `aia_peers::LOCAL_PEER_ID` 와 같다. */
const LOCAL_PEER_ID = "local";
/** 교환 회수 한 번이 백엔드에서 기다리는 시간. 상한(25초) 아래로 둔다. */
const EXCHANGE_WAIT_MS = 20_000;
const EXCHANGE_LIST_LIMIT = 30;

interface PeerDraft {
  id: string;
  name: string;
  url: string;
  note: string;
}

function draftOf(peer: AiaPeerView | null): PeerDraft {
  return { id: peer?.id ?? "", name: peer?.name ?? "", url: peer?.url ?? "", note: peer?.note ?? "" };
}

interface PolicyDraft {
  allowLocal: boolean;
  maxDepth: string;
  maxConcurrent: string;
  timeoutMinutes: string;
  deviceName: string;
}

function policyDraftOf(policy: AiaPeerPolicy): PolicyDraft {
  return {
    allowLocal: policy.allowLocal,
    maxDepth: String(policy.maxDepth),
    maxConcurrent: String(policy.maxConcurrent),
    timeoutMinutes: String(Math.round(policy.timeoutMs / 60_000)),
    deviceName: policy.deviceName,
  };
}

function wholeNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

type Text = (ko: string, en: string) => string;

function skillStateLabel(text: Text, state: AiaPeerSkillState): string {
  switch (state) {
    case "absent": return text("없음", "Not here");
    case "same": return text("같음", "Same");
    case "peerNewer": return text("피어가 새로움", "Peer newer");
    case "localModified": return text("내가 고침", "Edited here");
    case "bothChanged": return text("둘 다 바뀜", "Both changed");
    case "different": return text("다른 출처", "Other origin");
  }
}

function exchangeStateLabel(text: Text, state: AiaPeerExchangeView["state"]): string {
  switch (state) {
    case "running": return text("진행 중", "Running");
    case "completed": return text("완료", "Completed");
    case "failed": return text("실패", "Failed");
    case "timedOut": return text("시간 초과", "Timed out");
    case "refused": return text("거절됨", "Refused");
  }
}

function CheckReceipt({ receipt }: { receipt: AiaPeerCheckReceipt }) {
  const { text } = useI18n();
  if (!receipt.reachable) return <p className="db-connection-receipt failed">{receipt.message}</p>;
  return (
    <div className={`db-connection-receipt ${receipt.enabled ? "ok" : "failed"}`}>
      <p>{receipt.message}</p>
      {receipt.device && <p><code>{receipt.device.name}</code> · {text("계약", "Protocol")} v{receipt.protocolVersion ?? "?"}</p>}
    </div>
  );
}

function SkillsPanel({ view, busy, onImport }: {
  view: AiaPeerSkillsView;
  busy: string | null;
  onImport: (key: string, state: AiaPeerSkillState) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="db-connection-receipt ok aia-peer-skills">
      <p><strong>{text(`${view.peerName}의 공통 스킬`, `Common skills on ${view.peerName}`)}</strong> · {view.skills.length}</p>
      {view.skills.length === 0 && <p>{text("상대 기기에 공통 스킬이 없습니다.", "The peer has no common skills.")}</p>}
      <ul>
        {view.skills.map((skill) => {
          const importable = skill.state !== "same";
          return (
            <li key={skill.key}>
              <code>{skill.key}</code> <span className="db-badge">{skillStateLabel(text, skill.state)}</span>
              {skill.description ? ` · ${skill.description}` : ""}
              {importable && (
                <button className="button compact" type="button" disabled={busy !== null} onClick={() => onImport(skill.key, skill.state)}>
                  {busy === `import:${skill.key}` ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}
                  {skill.state === "absent" || skill.state === "peerNewer" ? text("가져오기", "Import") : text("덮어쓰기", "Overwrite")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {view.unavailable.map((item) => <p key={item.key}>{item.key}: {item.reason}</p>)}
    </div>
  );
}

function ExchangeRow({ exchange }: { exchange: AiaPeerExchangeView }) {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const outbound = exchange.direction === "outbound";
  return (
    <article className="db-connection-row aia-peer-exchange" data-state={exchange.state}>
      <div className="db-connection-head">
        <strong>{outbound ? text(`→ ${exchange.peerName}`, `→ ${exchange.peerName}`) : text(`← ${exchange.device.name}`, `← ${exchange.device.name}`)}</strong>
        <span className="db-badge">{exchangeStateLabel(text, exchange.state)}</span>
        {exchange.state === "running" && <LoaderCircle size={13} className="spin" />}
        <span className="db-badge">{text(`홉 ${exchange.hop}`, `hop ${exchange.hop}`)}</span>
      </div>
      <code className="db-connection-target">{exchange.questionPreview}</code>
      <small className="db-connection-meta">
        {formatRelative(exchange.startedAt)}
        {exchange.error ? ` · ${exchange.error}` : ""}
        {exchange.truncated ? ` · ${text("답이 잘림", "answer truncated")}` : ""}
      </small>
      {exchange.answer && (
        <div className="db-connection-actions">
          <button className="button compact" type="button" onClick={() => setOpen((value) => !value)}>
            {open ? text("답 접기", "Hide answer") : text("답 보기", "Show answer")}
          </button>
        </div>
      )}
      {open && exchange.answer && (
        <pre className="aia-peer-answer" data-untrusted="true">{exchange.answer}</pre>
      )}
    </article>
  );
}

function PeerRow({ peer, receipt, skills, busy, onToggle, onCheck, onSkills, onAsk, onEdit, onRemove, onImport }: {
  peer: AiaPeerView;
  receipt: AiaPeerCheckReceipt | null;
  skills: AiaPeerSkillsView | null;
  busy: string | null;
  onToggle: () => void;
  onCheck: () => void;
  onSkills: () => void;
  onAsk: (message: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  onImport: (key: string, state: AiaPeerSkillState) => void;
}) {
  const { text } = useI18n();
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState("");
  const send = () => {
    if (message.trim() === "") return;
    onAsk(message.trim());
    setMessage("");
    setAsking(false);
  };
  return (
    <article className="db-connection-row" data-peer-id={peer.id}>
      <div className="db-connection-head">
        <strong>{peer.name}</strong>
        {peer.skillsChanged && <span className="db-badge db-badge-staging">{text("스킬 변경 있음", "Skills changed")}</span>}
      </div>
      <code className="db-connection-target">{peer.url}</code>
      {peer.note && <small className="db-connection-meta">{peer.note}</small>}
      <div className="db-connection-actions">
        <label className="db-connection-toggle">
          <input type="checkbox" checked={peer.agentEnabled} disabled={busy !== null} onChange={() => onToggle()} />
          <span>{text("에이전트 사용", "Agent use")}</span>
        </label>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => onCheck()}>
          {busy === `check:${peer.id}` ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}{text("연결 확인", "Check")}
        </button>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => setAsking((value) => !value)}>
          <Send size={13} />{text("질문", "Ask")}
        </button>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => onSkills()}>
          {busy === `skills:${peer.id}` ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}{text("스킬", "Skills")}
        </button>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => onEdit()}>{text("편집", "Edit")}</button>
        <button className="button compact danger" type="button" disabled={busy !== null} onClick={() => onRemove()}><Trash2 size={13} />{text("삭제", "Remove")}</button>
      </div>
      {asking && (
        <div className="db-connection-editor aia-peer-ask">
          <Field label={text("상대 AIA 에게 보낼 질문", "Question for the peer AIA")} hint={text("비밀값·토큰은 적지 마세요. 상대 기기의 세션 기록에 그대로 남습니다.", "Do not include secrets or tokens. The peer keeps the session transcript.")}>
            <textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
          </Field>
          <div className="db-connection-editor-actions">
            <button className="button compact" type="button" onClick={() => setAsking(false)}>{text("취소", "Cancel")}</button>
            <button className="button compact primary" type="button" disabled={message.trim() === "" || busy !== null} onClick={send}>{text("보내기", "Send")}</button>
          </div>
        </div>
      )}
      {receipt?.id === peer.id && <CheckReceipt receipt={receipt} />}
      {skills?.peerId === peer.id && <SkillsPanel view={skills} busy={busy} onImport={onImport} />}
    </article>
  );
}

function PeerEditor({ draft, busy, patchDraft, onCancel, onSave }: {
  draft: PeerDraft;
  busy: string | null;
  patchDraft: (patch: Partial<PeerDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { text } = useI18n();
  const input = (key: keyof PeerDraft) => (event: ChangeEvent<HTMLInputElement>) => patchDraft({ [key]: event.target.value } as Partial<PeerDraft>);
  const valid = draft.name.trim() !== "" && draft.url.trim() !== "";
  return (
    <div className="db-connection-editor" data-ui-anchor="addons.peers.editor">
      <Field label={text("이름", "Name")}><input value={draft.name} maxLength={64} placeholder="NAS" onChange={input("name")} /></Field>
      <Field
        label={text("주소", "Address")}
        hint={text(
          "상대 기기의 테일넷 HTTPS 주소(예: https://nas.tail1234.ts.net). 상대 기기에서 원격 접속(Tailscale)이 켜져 있고 AIA 대화가 켜져 있어야 요청을 받습니다. 경로·계정 정보는 넣지 않습니다.",
          "The peer's tailnet HTTPS address (e.g. https://nas.tail1234.ts.net). The peer must have remote access (Tailscale) and AIA peers turned on. No path or credentials.",
        )}
      >
        <input value={draft.url} placeholder="https://nas.tail1234.ts.net" onChange={input("url")} />
      </Field>
      <Field label={text("메모", "Note")}><input value={draft.note} maxLength={200} onChange={input("note")} /></Field>
      <div className="db-connection-editor-actions">
        <button className="button compact" type="button" onClick={() => onCancel()}>{text("취소", "Cancel")}</button>
        <button className="button compact primary" type="button" disabled={!valid || busy !== null} onClick={() => onSave()}>{text("저장", "Save")}</button>
      </div>
    </div>
  );
}

/**
 * 애드온의 AIA 대화 탭(C23). 다른 기기의 AIA 에게 묻는 피어를 등록하고, 이 기기가 요청을
 * 받을지와 얼마나 받을지를 정하는 자리다.
 *
 * 자격증명은 없다 — 회원 자격은 테일넷이 증명하고, 이 카드가 저장하는 것은 주소·이름·토글·
 * 정책뿐이다. 교환 기록은 백엔드 메모리의 것이라 재기동 뒤에는 비어 있다.
 */
export function AiaPeersCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<AiaPeersSnapshot | null>(null);
  const { busy, error, setError, run: runAction } = useBusyAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<PeerDraft>(draftOf(null));
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft | null>(null);
  const [receipt, setReceipt] = useState<AiaPeerCheckReceipt | null>(null);
  const [skills, setSkills] = useState<AiaPeerSkillsView | null>(null);
  const [exchanges, setExchanges] = useState<AiaPeerExchangeView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState("");
  const loadedRef = useRef(false);
  const pollingRef = useRef<Set<string>>(new Set());
  const patchDraft = (patch: Partial<PeerDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const [snapshotGate] = useState(createLatestGate);
  const applyLatest = useCallback(async (request: Promise<AiaPeersSnapshot>) => {
    const isCurrent = snapshotGate.begin();
    const next = await request;
    if (isCurrent()) {
      setSnapshot(next);
      setPolicyDraft(policyDraftOf(next.policy));
    }
  }, [snapshotGate]);

  const loadExchanges = useCallback(async () => {
    try {
      setExchanges(await listAiaPeerExchanges(EXCHANGE_LIST_LIMIT));
    } catch {
      // 교환 목록은 부가 정보다. 읽지 못해도 피어 카드는 그대로 쓴다.
    }
  }, []);

  const load = useCallback(async () => {
    const isCurrent = snapshotGate.begin();
    try {
      const next = await getAiaPeers();
      if (!isCurrent()) return;
      setSnapshot(next);
      setPolicyDraft(policyDraftOf(next.policy));
      setError(null);
      void loadExchanges();
    } catch (cause) {
      if (isCurrent()) setError(errorText(cause));
    }
  }, [snapshotGate, loadExchanges]);

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [active, load]);

  // 진행 중인 교환은 결과가 날 때까지 회수를 이어 간다. 한 교환에 한 줄만 돈다.
  const follow = useCallback((id: string) => {
    if (pollingRef.current.has(id)) return;
    pollingRef.current.add(id);
    void (async () => {
      try {
        for (;;) {
          const view = await getAiaPeerExchange(id, EXCHANGE_WAIT_MS);
          setExchanges((current) => {
            const index = current.findIndex((item) => item.id === view.id);
            if (index < 0) return [view, ...current];
            const next = current.slice();
            next[index] = view;
            return next;
          });
          if (view.state !== "running") break;
        }
      } catch {
        // 백엔드가 다시 떠서 교환이 사라졌으면 목록을 새로 읽는 것으로 충분하다.
      } finally {
        pollingRef.current.delete(id);
        void loadExchanges();
      }
    })();
  }, [loadExchanges]);

  useEffect(() => {
    exchanges.filter((exchange) => exchange.state === "running").forEach((exchange) => follow(exchange.id));
  }, [exchanges, follow]);

  const run = async (token: string, action: () => Promise<void>) => {
    if (busy !== null) return;
    setNotice(null);
    await runAction(token, action);
  };

  const openEditor = (peer: AiaPeerView | null) => {
    setEditing(peer ? peer.id : "new");
    setDraft(draftOf(peer));
    setReceipt(null);
  };

  const save = () => run("save", async () => {
    await applyLatest(setAiaPeer({ id: draft.id === "" ? null : draft.id, name: draft.name, url: draft.url, note: draft.note, agentEnabled: null }));
    setEditing(null);
  });

  const toggleEnabled = (enabled: boolean) => run("policy:enabled", async () => {
    await applyLatest(setAiaPeerPolicy({ enabled }));
  });

  const savePolicy = () => run("policy", async () => {
    if (!policyDraft) return;
    const maxDepth = wholeNumber(policyDraft.maxDepth);
    const maxConcurrent = wholeNumber(policyDraft.maxConcurrent);
    const timeoutMinutes = wholeNumber(policyDraft.timeoutMinutes);
    if (maxDepth === null || maxConcurrent === null || timeoutMinutes === null) {
      throw new Error(text("홉 상한·동시 수신·응답 대기는 0 이상의 정수여야 합니다", "Hop cap, concurrency and timeout must be whole numbers"));
    }
    await applyLatest(setAiaPeerPolicy({
      allowLocal: policyDraft.allowLocal,
      maxDepth,
      maxConcurrent,
      timeoutMs: timeoutMinutes * 60_000,
      deviceName: policyDraft.deviceName,
    }));
    setNotice(text("정책을 저장했습니다.", "Policy saved."));
  });

  const toggle = (peer: AiaPeerView) => run(`toggle:${peer.id}`, async () => {
    await applyLatest(setAiaPeerAgentEnabled({ id: peer.id, enabled: !peer.agentEnabled }));
  });

  const check = (peer: AiaPeerView) => run(`check:${peer.id}`, async () => {
    setSkills(null);
    setReceipt(await checkAiaPeer({ id: peer.id }));
  });

  const showSkills = (peer: AiaPeerView) => run(`skills:${peer.id}`, async () => {
    setReceipt(null);
    setSkills(await listAiaPeerSkills(peer.id));
    void load();
  });

  const ask = (peerId: string, message: string) => run(`ask:${peerId}`, async () => {
    const exchange = await askAiaPeer({ peerId, message, timeoutMs: null });
    setExchanges((current) => [exchange, ...current.filter((item) => item.id !== exchange.id)]);
    follow(exchange.id);
  });

  const importSkill = (peer: AiaPeerView, key: string, state: AiaPeerSkillState) => run(`import:${key}`, async () => {
    const overwrite = state === "localModified" || state === "bothChanged" || state === "different";
    if (overwrite) {
      const ok = await confirm({
        title: text("내 사본을 덮어쓸까요?", "Overwrite the local copy?"),
        message: text(
          `'${key}' 스킬의 내 사본이 ${peer.name}의 사본과 다릅니다(${skillStateLabel(text, state)}). 가져오면 내 사본이 ${peer.name}의 내용으로 바뀝니다.`,
          `Your copy of '${key}' differs from the one on ${peer.name} (${skillStateLabel(text, state)}). Importing replaces your copy with the peer's content.`,
        ),
        warning: text("내 사본의 변경은 되돌릴 수 없습니다.", "Local edits cannot be restored."),
        confirmLabel: text("덮어쓰기", "Overwrite"),
        tone: "danger",
      });
      if (!ok) return;
    }
    const receipt = await importAiaPeerSkill({ peerId: peer.id, key, overwrite });
    setNotice(receipt.created
      ? text(`'${receipt.key}' 스킬을 새로 만들어 가져왔습니다(파일 ${receipt.fileCount}개).`, `Imported '${receipt.key}' as a new skill (${receipt.fileCount} file(s)).`)
      : text(`'${receipt.key}' 스킬을 갱신해 가져왔습니다(파일 ${receipt.fileCount}개).`, `Imported '${receipt.key}' over the existing copy (${receipt.fileCount} file(s)).`));
    setSkills(await listAiaPeerSkills(peer.id));
  });

  const remove = (peer: AiaPeerView) => run(`remove:${peer.id}`, async () => {
    const ok = await confirm({
      title: text("피어를 삭제할까요?", "Remove this peer?"),
      message: text(
        `${peer.name} 등록을 지웁니다. 상대 기기는 바뀌지 않고, 가져온 스킬도 그대로 남습니다.`,
        `Removes ${peer.name}. The peer device is unchanged and imported skills stay.`,
      ),
      confirmLabel: text("삭제", "Remove"),
      tone: "danger",
    });
    if (!ok) return;
    await applyLatest(removeAiaPeer({ id: peer.id }));
    if (editing === peer.id) setEditing(null);
  });

  const policy = snapshot?.policy ?? null;

  return (
    <section className="settings-card db-connections-card" data-ui-anchor="addons.peers-content">
      <header>
        <div className="plugin-page-title">
          <i><MessagesSquare size={18} aria-hidden="true" /></i>
          <div><span>{text("AIA 대화", "AIA peers")}</span><h2>{text("다른 기기의 AIA 에게 묻기", "Ask another device's AIA")}</h2></div>
        </div>
        <p>{text(
          "같은 테일넷의 다른 Agent Manager 를 피어로 등록하면 이 기기의 AIA 가 그 기기의 AIA 에게 묻고 답을 받습니다. 자격증명은 없습니다 — 같은 테일넷 사용자의 기기라는 사실이 곧 회원 자격이고, 받는 쪽은 무인 AIA 가 답만 합니다. 상대의 공통 스킬은 필요할 때 하나씩 가져옵니다.",
          "Register other Agent Managers on the same tailnet as peers and this device's AIA can ask their AIA and read the answer. No credentials — being a device of the same tailnet user is the membership, and the receiving side answers with an unattended AIA. Common skills are fetched one at a time when needed.",
        )}</p>
      </header>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="db-connection-receipt ok aia-peer-notice">{notice}</p>}
      {snapshot === null || policy === null || policyDraft === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{text("피어를 확인하는 중…", "Checking peers…")}</span></div>
        : <>
          <div className="settings-update-body" data-ui-anchor="addons.peers.policy">
            <span className="settings-update-status">
              <strong>{text("AIA 대화 사용", "AIA peers")}</strong>
              <small>{text(`이 기기: ${snapshot.device.name}`, `This device: ${snapshot.device.name}`)} · {snapshot.inboundReady
                ? text("다른 기기의 요청을 받을 수 있습니다", "can receive requests from peers")
                : text("원격 접속(Tailscale)이 꺼져 있어 묻는 것만 됩니다", "remote access (Tailscale) is off, so it can only ask")}</small>
            </span>
            <AppToggle checked={policy.enabled} disabled={busy !== null} label={text("AIA 대화 사용", "AIA peers")} onChange={(checked) => void toggleEnabled(checked)} />
          </div>
          {snapshot.issues.map((issue) => <p key={issue} className="db-connection-receipt failed"><TriangleAlert size={13} /> {issue}</p>)}
          <div className="db-connection-editor aia-peer-policy">
            <Field label={text("같은 기기 AIA 에게 묻기", "Ask an AIA on this device")} hint={text("켜면 AIA 가 이 기기의 새 무인 AIA(local)에게도 물을 수 있습니다.", "When on, the AIA may also ask a new unattended AIA on this device (local).")}>
              <AppToggle checked={policyDraft.allowLocal} disabled={busy !== null} label={text("같은 기기 AIA 허용", "Allow local AIA")} onChange={(allowLocal) => setPolicyDraft({ ...policyDraft, allowLocal })} />
            </Field>
            <Field label={text("홉 상한", "Hop cap")} hint={text(`요청이 거칠 수 있는 기기 수(${snapshot.defaults.maxDepthMin}~${snapshot.defaults.maxDepthMax}). 사슬이 이 길이에 닿으면 받는 쪽이 거절합니다.`, `How many devices a request may pass through (${snapshot.defaults.maxDepthMin}–${snapshot.defaults.maxDepthMax}).`)}>
              <input type="number" min={snapshot.defaults.maxDepthMin} max={snapshot.defaults.maxDepthMax} value={policyDraft.maxDepth} onChange={(event) => setPolicyDraft({ ...policyDraft, maxDepth: event.target.value })} />
            </Field>
            <Field label={text("동시 수신", "Concurrent inbound")} hint={text(`동시에 받아 돌리는 요청 수(${snapshot.defaults.maxConcurrentMin}~${snapshot.defaults.maxConcurrentMax}).`, `Requests answered at the same time (${snapshot.defaults.maxConcurrentMin}–${snapshot.defaults.maxConcurrentMax}).`)}>
              <input type="number" min={snapshot.defaults.maxConcurrentMin} max={snapshot.defaults.maxConcurrentMax} value={policyDraft.maxConcurrent} onChange={(event) => setPolicyDraft({ ...policyDraft, maxConcurrent: event.target.value })} />
            </Field>
            <Field label={text("응답 대기(분)", "Answer timeout (minutes)")} hint={text(`${snapshot.defaults.timeoutMsMin / 60_000}~${snapshot.defaults.timeoutMsMax / 60_000}분. 넘으면 답하던 무인 AIA 를 멈춥니다.`, `${snapshot.defaults.timeoutMsMin / 60_000}–${snapshot.defaults.timeoutMsMax / 60_000} minutes; past it the answering AIA is stopped.`)}>
              <input type="number" min={snapshot.defaults.timeoutMsMin / 60_000} max={snapshot.defaults.timeoutMsMax / 60_000} value={policyDraft.timeoutMinutes} onChange={(event) => setPolicyDraft({ ...policyDraft, timeoutMinutes: event.target.value })} />
            </Field>
            <Field label={text("기기 이름", "Device name")} hint={text("다른 기기에 보이는 이름. 비우면 Tailscale 호스트 이름을 씁니다.", "Shown to other devices. Empty uses the Tailscale host name.")}>
              <input value={policyDraft.deviceName} maxLength={64} onChange={(event) => setPolicyDraft({ ...policyDraft, deviceName: event.target.value })} />
            </Field>
            <div className="db-connection-editor-actions">
              <button className="button compact primary" type="button" disabled={busy !== null} onClick={() => void savePolicy()}>{text("정책 저장", "Save policy")}</button>
            </div>
          </div>
          <div className="ssh-key-location">
            <span><strong>{text("등록된 피어", "Registered peers")}</strong><code>{snapshot.peers.length}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {snapshot.peers.length === 0
            ? <div className="plugin-empty-state"><i><MessagesSquare size={25} /></i><div><strong>{text("등록된 피어가 없습니다", "No peers yet")}</strong><small>{text("피어를 등록하고 에이전트 사용을 켜야 AIA 가 그 기기에 물을 수 있습니다.", "Register a peer and turn on agent use before the AIA can ask it.")}</small></div></div>
            : <div className="plugin-list db-connection-list">
              {snapshot.peers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  peer={peer}
                  receipt={receipt}
                  skills={skills}
                  busy={busy}
                  onToggle={() => void toggle(peer)}
                  onCheck={() => void check(peer)}
                  onSkills={() => void showSkills(peer)}
                  onAsk={(message) => void ask(peer.id, message)}
                  onEdit={() => openEditor(peer)}
                  onRemove={() => void remove(peer)}
                  onImport={(key, state) => void importSkill(peer, key, state)}
                />
              ))}
            </div>}
          {editing === null
            ? <div className="settings-update-body">
              <span className="settings-update-status"><strong>{text("새 피어", "New peer")}</strong><small>{text("상대 기기의 테일넷 HTTPS 주소를 넣습니다. 토큰이나 비밀번호는 없습니다.", "Enter the peer's tailnet HTTPS address. There is no token or password.")}</small></span>
              <button className="button compact primary" type="button" data-ui-anchor="addons.peers.add" onClick={() => openEditor(null)}><Plus size={13} />{text("피어 추가", "Add peer")}</button>
            </div>
            : <PeerEditor draft={draft} busy={busy} patchDraft={patchDraft} onCancel={() => setEditing(null)} onSave={() => void save()} />}
          {policy.allowLocal && policy.enabled && (
            <div className="db-connection-editor aia-peer-ask" data-ui-anchor="addons.peers.local">
              <Field label={text("같은 기기 AIA 에게 묻기", "Ask this device's AIA")} hint={text("이 기기의 새 무인 AIA 에게 질문을 보내 교환 흐름을 확인합니다.", "Send a question to a new unattended AIA on this device to try the flow.")}>
                <textarea rows={2} value={localMessage} onChange={(event) => setLocalMessage(event.target.value)} />
              </Field>
              <div className="db-connection-editor-actions">
                <button className="button compact primary" type="button" disabled={localMessage.trim() === "" || busy !== null} onClick={() => {
                  const message = localMessage.trim();
                  setLocalMessage("");
                  void ask(LOCAL_PEER_ID, message);
                }}><Send size={13} />{text("질문 보내기", "Send")}</button>
              </div>
            </div>
          )}
          <div className="ssh-key-location">
            <span><strong>{text("최근 교환", "Recent exchanges")}</strong><code>{exchanges.length}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void loadExchanges()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {exchanges.length === 0
            ? <p className="db-connection-meta aia-peer-empty">{text("아직 교환이 없습니다. 백엔드가 다시 뜨면 목록은 비워지고 영수증만 앱 데이터에 남습니다.", "No exchanges yet. The list is cleared when the backend restarts; receipts stay in app data.")}</p>
            : <div className="plugin-list db-connection-list" data-ui-anchor="addons.peers.exchanges">
              {exchanges.map((exchange) => <ExchangeRow key={exchange.id} exchange={exchange} />)}
            </div>}
        </>}
      {confirmDialog}
    </section>
  );
}
