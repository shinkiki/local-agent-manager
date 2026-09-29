/**
 * 로컬 LLM 연결 목록 카드(M7 7.4).
 *
 * 다른 공급자는 CLI를 설치하고 로그인해 계정을 등록하지만, 이 공급자는 사용자가 직접 띄운
 * 서버 주소가 전부다. 그래서 계정 목록 옆이 아니라 자기 구획을 따로 두고, 계정 카드가
 * 하는 일(로그인·활성 전환·사용량) 대신 "어디에 붙어 어떤 모델을 기본으로 쓸지"만 묻는다.
 *
 * 연결은 여러 개다 — 이 기계의 Ollama 와 Tailscale 너머 다른 기계의 Ollama 를 함께 두고
 * 채팅마다 고른다. 목록 한 줄이 연결 하나이고, 추가·편집은 아래 한 폼이 맡는다. 기본
 * 연결은 연결을 고르지 않은 채팅·반복요청이 쓰는 것이라 목록에서 따로 지정한다.
 *
 * API 키는 쓰기 전용이다. 저장본은 키가 있는지만 알려 주므로 화면도 값을 되읽지 않고,
 * 빈 칸은 "그대로 두기"이지 "지우기"가 아니다. 지우는 것은 버튼으로 따로 시킨다.
 */
import { LoaderCircle, Plus, Server, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../lib/i18n";
import {
  getLocalLlmConnections,
  probeLocalLlmConnection,
  removeLocalLlmConnection,
  setDefaultLocalLlmConnection,
  upsertLocalLlmConnection,
} from "../lib/ipc";
import { refreshProviderOptions } from "../lib/providerOptions";
import type { LocalLlmConnectionEntry, LocalLlmConnections, LocalLlmProbeResult } from "../types";
import { ErrorBanner, useConfirm } from "./Shared";

/** 서버가 목록을 주지 않을 때 기본 모델 칸을 막지 않으려고 쓰는 자유 입력 표식. */
const CUSTOM_MODEL = "__custom__";
/** 주소를 적는 동안 자동으로 점검하기까지 기다리는 시간. 글자마다 HTTP 를 걸지 않는다. */
const AUTO_PROBE_DELAY_MS = 700;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 편집 폼이 드는 값. 새 연결이면 `id` 가 null 이다. */
interface ConnectionDraft {
  id: string | null;
  label: string;
  baseUrl: string;
  defaultModel: string;
  contextWindow: string;
  apiKey: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
}

function emptyDraft(): ConnectionDraft {
  return { id: null, label: "", baseUrl: "", defaultModel: "", contextWindow: "", apiKey: "", enabled: true, apiKeyConfigured: false };
}

function draftFrom(entry: LocalLlmConnectionEntry): ConnectionDraft {
  return {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    defaultModel: entry.defaultModel,
    contextWindow: entry.contextWindow ? String(entry.contextWindow) : "",
    // 저장된 키는 되읽지 않는다. 입력 칸은 언제나 빈 채로 시작한다.
    apiKey: "",
    enabled: entry.enabled,
    apiKeyConfigured: entry.apiKeyConfigured,
  };
}

/** 주소가 점검할 만한 모양인지. 스킴과 호스트가 있어야 HTTP 를 건다. */
function probeable(baseUrl: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(baseUrl.trim());
}

export function LocalLlmConnectionCard() {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [list, setList] = useState<LocalLlmConnections | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [probe, setProbe] = useState<LocalLlmProbeResult | null>(null);
  /** 목록 대신 손으로 적겠다고 고른 상태. 저장된 이름이 마침 목록에 있어도 입력칸을 연다. */
  const [manualModel, setManualModel] = useState(false);
  /** 목록 줄의 점검 결과. 연결 id 별로 마지막 결과만 든다. */
  const [rowProbes, setRowProbes] = useState<Record<string, LocalLlmProbeResult>>({});
  const [busy, setBusy] = useState<"load" | "probe" | "save" | "row" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy("load");
    return getLocalLlmConnections()
      .then((next) => setList(next))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(null));
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 주소를 적으면 잠시 뒤 스스로 점검한다. Tailscale 너머 주소처럼 손으로 적는 값은 오타가
  // 흔하고, "확인"을 누를 때까지 결과를 감추면 저장한 뒤 채팅이 거절될 때 처음 안다.
  const draftBaseUrl = draft?.baseUrl ?? "";
  useEffect(() => {
    if (!draft || !probeable(draftBaseUrl)) { setProbe(null); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      setBusy((current) => current ?? "probe");
      probeLocalLlmConnection(draftBaseUrl)
        .then((result) => { if (alive) setProbe(result); })
        .catch(() => undefined)
        .finally(() => { if (alive) setBusy((current) => (current === "probe" ? null : current)); });
    }, AUTO_PROBE_DELAY_MS);
    return () => { alive = false; window.clearTimeout(timer); };
    // draft 전체가 아니라 주소가 바뀔 때만 다시 점검한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftBaseUrl, draft !== null]);

  const openNew = useCallback(() => {
    setDraft(emptyDraft());
    setProbe(null);
    setManualModel(false);
    setNotice(null);
    setError(null);
  }, []);

  const openEdit = useCallback((entry: LocalLlmConnectionEntry) => {
    setDraft(draftFrom(entry));
    setProbe(null);
    setManualModel(false);
    setNotice(null);
    setError(null);
  }, []);

  const update = useCallback((patch: Partial<ConnectionDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const runProbe = useCallback(() => {
    if (!draft) return;
    setBusy("probe");
    setError(null);
    probeLocalLlmConnection(draft.baseUrl)
      .then((result) => setProbe(result))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(null));
  }, [draft]);

  const afterChange = useCallback((message: string) => {
    setNotice(message);
    // 새 채팅의 연결·모델 목록이 바뀐 주소를 곧바로 따르게 한다.
    return refreshProviderOptions("local").catch(() => undefined);
  }, []);

  const save = useCallback((nextApiKey: string | undefined) => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    const parsedWindow = Number.parseInt(draft.contextWindow, 10);
    upsertLocalLlmConnection({
      id: draft.id ?? undefined,
      label: draft.label,
      baseUrl: draft.baseUrl,
      defaultModel: draft.defaultModel,
      contextWindow: Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : null,
      enabled: draft.enabled,
      apiKey: nextApiKey,
    })
      .then((saved) => {
        setDraft(draftFrom(saved));
        return load().then(() => afterChange(text("연결을 저장했습니다.", "Connection saved.")));
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(null));
  }, [afterChange, draft, load, text]);

  const clearApiKey = useCallback(() => {
    void confirm({
      title: text("API 키를 지울까요?", "Remove the API key?"),
      message: text(
        "보안 저장소에 저장된 키를 지웁니다. 서버가 키를 요구하면 다시 입력해야 합니다.",
        "This deletes the key from the OS secure store. You must enter it again if the server requires one.",
      ),
      confirmLabel: text("지우기", "Remove"),
      tone: "danger",
    }).then((accepted) => { if (accepted) save(""); });
  }, [confirm, save, text]);

  const makeDefault = useCallback((entry: LocalLlmConnectionEntry) => {
    setBusy("row");
    setError(null);
    setDefaultLocalLlmConnection(entry.id)
      .then((next) => { setList(next); return afterChange(text(`'${entry.label}'을(를) 기본 연결로 지정했습니다.`, `'${entry.label}' is now the default connection.`)); })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(null));
  }, [afterChange, text]);

  const remove = useCallback((entry: LocalLlmConnectionEntry) => {
    void confirm({
      title: text(`'${entry.label}' 연결을 지울까요?`, `Remove the '${entry.label}' connection?`),
      message: text(
        "이 연결을 고른 채팅·반복요청은 기본 연결로 돌아갑니다. 저장된 API 키도 함께 지웁니다. 마지막 연결은 지울 수 없습니다.",
        "Chats and recurring requests that picked this connection fall back to the default one. Its stored API key is removed too. The last connection cannot be removed.",
      ),
      confirmLabel: text("지우기", "Remove"),
      tone: "danger",
    }).then((accepted) => {
      if (!accepted) return;
      setBusy("row");
      setError(null);
      removeLocalLlmConnection(entry.id)
        .then((next) => {
          setList(next);
          if (draft?.id === entry.id) setDraft(null);
          return afterChange(text("연결을 지웠습니다.", "Connection removed."));
        })
        .catch((cause) => setError(errorMessage(cause)))
        .finally(() => setBusy(null));
    });
  }, [afterChange, confirm, draft?.id, text]);

  const probeRow = useCallback((entry: LocalLlmConnectionEntry) => {
    setBusy("row");
    probeLocalLlmConnection(entry.baseUrl)
      .then((result) => setRowProbes((current) => ({ ...current, [entry.id]: result })))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(null));
  }, []);

  const connections = list?.connections ?? [];
  const anyEnabled = connections.some((entry) => entry.enabled && entry.baseUrl.trim() !== "");
  const models = probe?.models ?? [];
  const defaultModel = draft?.defaultModel ?? "";
  // 고른 것이 목록 밖이면 당연히 자유 입력이고, 목록 안이어도 사용자가 직접 입력을
  // 골랐으면 그대로 연다. 뒤 조건이 없으면 "직접 입력"을 골라도 아무 일이 없다.
  const usesCustomModel = manualModel || models.length === 0 || !models.includes(defaultModel);
  // 서버는 목록을 줬는데 고른 이름이 거기 없다. 이 상태로 저장하면 채팅 기동이 거절된다.
  const modelMissing = models.length > 0 && defaultModel.trim() !== "" && !models.includes(defaultModel);
  const loading = busy === "load" && list === null;

  const probeBadge = (result: LocalLlmProbeResult) => (
    <span className={result.reachable && !result.error ? "health ready" : "health warning"}>
      {result.reachable
        ? text(`닿음 · 모델 ${result.models.length}개${result.server ? ` · ${result.server}` : ""}`,
          `Reachable · ${result.models.length} models${result.server ? ` · ${result.server}` : ""}`)
        : text("닿지 않음", "Unreachable")}
    </span>
  );

  return (
    <section className="settings-subsection" data-ui-anchor="settings.local-llm">
      <header>
        <div>
          <strong>{text("로컬 LLM 연결", "Local LLM connections")}</strong>
          <small>{text(
            "직접 띄운 OpenAI 호환 서버(예: Ollama)에 붙습니다. 이 기계의 서버와 다른 기계(Tailscale 등)의 서버를 여러 개 두고 채팅마다 고릅니다. 계정과 사용량 한도가 없고, 도구 실행은 OpenCode 하네스가 맡습니다.",
            "Connects to OpenAI-compatible servers you run yourself (for example Ollama). Keep several — this machine and others over Tailscale — and pick one per chat. There is no account or usage quota, and the OpenCode harness runs the tools.",
          )}</small>
        </div>
        <span className={anyEnabled ? "health ready" : "health warning"}>
          {anyEnabled ? text("사용 중", "In use") : text("꺼짐", "Off")}
        </span>
      </header>
      {error && <ErrorBanner message={error} />}
      {loading ? (
        <p className="settings-storage-note">{text("연결 목록을 불러오는 중…", "Loading connections…")}</p>
      ) : (
        <div className="plugin-list db-connection-list">
          {connections.map((entry) => {
            const isDefault = list?.defaultId === entry.id;
            const rowProbe = rowProbes[entry.id];
            return (
              <article className="db-connection-row" key={entry.id} data-connection-id={entry.id}>
                <div className="db-connection-head">
                  <strong>{entry.label}</strong>
                  {isDefault && <span className="db-badge">{text("기본", "Default")}</span>}
                  <span className={entry.enabled ? "health ready" : "health warning"}>
                    {entry.enabled ? text("사용", "Enabled") : text("꺼짐", "Off")}
                  </span>
                  {entry.apiKeyConfigured && <span className="db-badge">{text("API 키 저장됨", "API key saved")}</span>}
                </div>
                <code className="db-connection-target">{entry.baseUrl || text("(주소 없음)", "(no address)")}</code>
                <small className="db-connection-meta">
                  {text("기본 모델", "Default model")} {entry.defaultModel || "—"}
                  {entry.contextWindow ? ` · ${text("컨텍스트", "Context")} ${entry.contextWindow.toLocaleString()}` : ""}
                  {` · id ${entry.id}`}
                </small>
                <div className="db-connection-actions">
                  <button className="button compact" type="button" disabled={busy !== null || !probeable(entry.baseUrl)} onClick={() => probeRow(entry)}>
                    <Server size={13} />{text("점검", "Check")}
                  </button>
                  <button className="button compact" type="button" disabled={busy !== null} onClick={() => openEdit(entry)}>{text("편집", "Edit")}</button>
                  {!isDefault && <button className="button compact" type="button" disabled={busy !== null} onClick={() => makeDefault(entry)}>
                    <Star size={13} />{text("기본으로", "Make default")}
                  </button>}
                  <button className="button compact danger" type="button" disabled={busy !== null || connections.length <= 1} onClick={() => remove(entry)}>
                    <Trash2 size={13} />{text("삭제", "Remove")}
                  </button>
                </div>
                {rowProbe && <p className="settings-storage-note">{probeBadge(rowProbe)}{rowProbe.error ? ` ${rowProbe.error}` : ""}</p>}
              </article>
            );
          })}
          {connections.length === 0 && <p className="settings-storage-note">{text("등록된 연결이 없습니다.", "No connections yet.")}</p>}
          <div className="path-field-group">
            <button className="button compact" type="button" disabled={busy !== null} onClick={openNew}>
              <Plus size={13} />{text("연결 추가", "Add connection")}
            </button>
            {notice && <span className="health ready" role="status">{notice}</span>}
          </div>
        </div>
      )}
      {draft && (
        <div className="detail-card" data-ui-anchor="settings.local-llm.editor">
          <div className="form-row">
            <label htmlFor="local-llm-label">{text("이름", "Name")}</label>
            <div>
              <input
                id="local-llm-label"
                type="text"
                value={draft.label}
                placeholder={text("예: 이 기계 Ollama, 맥북 Ollama", "e.g. This machine, MacBook Ollama")}
                disabled={busy === "save"}
                onChange={(event) => update({ label: event.target.value })}
              />
              {draft.id && <small className="local-llm-hint">{text(`연결 id: ${draft.id}`, `Connection id: ${draft.id}`)}</small>}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="local-llm-base-url">{text("서버 주소", "Server address")}</label>
            <div>
              <input
                id="local-llm-base-url"
                type="text"
                value={draft.baseUrl}
                placeholder="http://127.0.0.1:11434/v1"
                disabled={busy === "save"}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
              <small className="local-llm-hint">{text(
                "다른 기계의 서버는 그 기계의 Tailscale 주소를 적습니다(예: http://100.x.y.z:11434/v1). 적는 동안 자동으로 점검합니다.",
                "For a server on another machine, use its Tailscale address (e.g. http://100.x.y.z:11434/v1). It is checked automatically as you type.",
              )}</small>
            </div>
          </div>
          <div className="form-row">
            <label>{text("연결 확인", "Check connection")}</label>
            <div className="path-field-group">
              <button
                className="button compact"
                type="button"
                disabled={busy !== null || !probeable(draft.baseUrl)}
                onClick={runProbe}
              >
                {busy === "probe" ? <LoaderCircle className="spin" size={13} /> : <Server size={13} />}
                {busy === "probe" ? text("확인 중…", "Checking…") : text("확인", "Check")}
              </button>
              {probe && probeBadge(probe)}
            </div>
          </div>
          {probe?.error && <p className="settings-storage-note">{probe.error}</p>}
          <div className="form-row">
            <label htmlFor="local-llm-model">{text("기본 모델", "Default model")}</label>
            <div className="path-field-group">
              <select
                id="local-llm-model"
                value={usesCustomModel ? CUSTOM_MODEL : defaultModel}
                disabled={busy === "save" || models.length === 0}
                onChange={(event) => {
                  const picked = event.target.value === CUSTOM_MODEL;
                  setManualModel(picked);
                  if (!picked) update({ defaultModel: event.target.value });
                }}
              >
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
                <option value={CUSTOM_MODEL}>{text("직접 입력", "Enter manually")}</option>
              </select>
              {usesCustomModel && <input
                type="text"
                value={defaultModel}
                placeholder="gpt-oss:20b"
                disabled={busy === "save"}
                onChange={(event) => update({ defaultModel: event.target.value })}
              />}
            </div>
          </div>
          {modelMissing && <p className="settings-storage-note" role="status">
            <span className="health warning">{text(
              `기본 모델 '${defaultModel}'이(가) 서버 목록에 없습니다. 목록에서 다시 고르고 저장하세요. 이대로 두면 모델을 따로 고르지 않은 로컬 채팅이 시작되지 않습니다.`,
              `The default model '${defaultModel}' is not in the server's list. Pick one from the list and save. Until then, local chats that do not pick a model will not start.`,
            )}</span>
          </p>}
          <div className="form-row">
            <label htmlFor="local-llm-context">{text("컨텍스트 크기", "Context window")}</label>
            <div>
              <input
                id="local-llm-context"
                type="number"
                min={1024}
                value={draft.contextWindow}
                placeholder={text("서버 기본값", "Server default")}
                disabled={busy === "save"}
                onChange={(event) => update({ contextWindow: event.target.value })}
              />
              <small className="local-llm-hint">{text(
                "비워 두면 모델마다 서버에 물어보고, 그래도 모르면 하네스가 창 크기를 몰라 자동 압축을 걸지 못합니다. 창이 차는 순간부터 답이 중간에 잘리고 도구 호출이 나오지 않습니다.",
                "Left empty, the server is asked per model; if it does not answer, the harness cannot know the window and never compacts. Once it fills, replies are cut mid-generation and tool calls stop coming.",
              )}</small>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="local-llm-api-key">{text("API 키", "API key")}</label>
            <div className="path-field-group">
              <input
                id="local-llm-api-key"
                type="password"
                value={draft.apiKey}
                autoComplete="off"
                placeholder={draft.apiKeyConfigured
                  ? text("저장됨 — 바꾸려면 새 값을 입력하세요", "Saved — enter a new value to replace it")
                  : text("서버가 요구할 때만 입력", "Only if the server requires one")}
                disabled={busy === "save"}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
              {draft.apiKeyConfigured && <button
                className="button compact"
                type="button"
                disabled={busy !== null}
                onClick={clearApiKey}
              >{text("키 지우기", "Remove key")}</button>}
            </div>
          </div>
          <div className="form-row">
            <label>{text("사용", "Enabled")}</label>
            <label className="check-filter">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={busy === "save"}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
              <span>{text("새 채팅에서 이 연결을 고를 수 있게 합니다.", "Allow picking this connection in new chats.")}</span>
            </label>
          </div>
          <div className="form-row">
            <label />
            <div className="path-field-group">
              <button
                className="button compact primary"
                type="button"
                disabled={busy !== null || draft.baseUrl.trim() === "" || draft.label.trim() === ""}
                onClick={() => save(draft.apiKey === "" ? undefined : draft.apiKey)}
              >
                {busy === "save" ? text("저장 중…", "Saving…") : draft.id ? text("저장", "Save") : text("추가", "Add")}
              </button>
              <button className="button compact" type="button" disabled={busy === "save"} onClick={() => setDraft(null)}>{text("닫기", "Close")}</button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
