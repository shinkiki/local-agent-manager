import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type DOMAttributes, type PropsWithChildren, type ReactNode, type Ref, type RefObject } from "react";
import { AlertTriangle, Check, ChevronDown, CircleQuestionMark, Inbox, Paperclip, ShieldAlert, Square, Undo2, X } from "lucide-react";
import { sourceName } from "../lib/format";
import { closesTopEscapeLayer, createEscapeLayerStack } from "../lib/escapeLayers";
import { CopyAction } from "./CopyAction";
import { displayPath } from "../lib/displayPath";
import { errorText } from "../lib/errorText";
import type { ProviderId, QueuedChatMessage, WorkflowInputField } from "../types";
import { useI18n } from "../lib/i18n";
import { folderDropMessage, splitDroppedFolders } from "../lib/fileDrop";

export function SourceBadge({ source }: { source: ProviderId }) {
  return <span className={`source-badge source-${source}`}>{sourceName(source)}</span>;
}

// 표식은 BrandMarks로 옮겼지만, 부르는 자리가 여기저기라 이름은 계속 Shared에서 받는다.
export { LogoMark, AiaMark, BrandMark, brandMarkIcon, ProviderMark } from "./BrandMarks";

export function LoadingState({ label }: { label?: string }) {
  const { text } = useI18n();
  const resolvedLabel = label ?? text("로컬 데이터를 읽고 있습니다", "Reading local data");
  return (
    <div className="state-panel">
      <span className="spinner" aria-hidden="true" />
      <p>{resolvedLabel}</p>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true"><Inbox size={22} strokeWidth={1.6} /></span>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}

/**
 * 긴 경로를 한 줄 입력칸으로 보여주고 오른쪽에 복사 버튼을 붙인다. `onChange`가 없으면
 * 읽기 전용이라 값이 바뀌지 않지만, 줄바꿈 없이 가로로 훑어보고 그대로 복사할 수 있다.
 */
export function PathField({ id, value, onChange, placeholder, disabled = false }: {
  id?: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const displayedValue = onChange ? value : displayPath(value);
  return (
    <div className="path-field">
      <input
        id={id}
        type="text"
        value={displayedValue}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={!onChange}
        spellCheck={false}
        autoComplete="off"
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        onFocus={onChange ? undefined : (event) => event.currentTarget.select()}
      />
      <CopyAction value={value} kind="path" className="path-field-copy" />
    </div>
  );
}

const escapeLayers = createEscapeLayerStack();

function closeTopEscapeLayer(event: KeyboardEvent) {
  if (!closesTopEscapeLayer(event)) return;
  const close = escapeLayers.top();
  if (!close) return;
  event.preventDefault();
  close();
}

/**
 * Esc로 이 겹침 UI를 닫는다. 여러 겹이 떠 있어도 가장 위 한 겹만 닫히도록 등록
 * 순서를 지키므로, 드로워 안에서 연 모달의 Esc가 드로워까지 닫지 않는다.
 * `enabled`가 false인 동안(닫혀 있는 팝오버 등)은 스택에서 빠진다.
 *
 * 겹침 순서는 "등록 순서 = 뜬 순서"라는 전제 위에 있다. 위 겹이 아래 겹보다 나중에
 * 뜨는 실제 흐름에서는 맞지만, 부모 겹과 자식 겹이 같은 렌더에서 함께 처음 뜨면
 * React가 자식 effect를 먼저 실행해 순서가 뒤집힌다. 그런 화면을 새로 만들 때는
 * 자식 겹을 처음부터 열어 두지 말고 열림 상태를 나중에 켜야 한다.
 */
export function useEscapeToClose(onEscape: () => void, enabled = true) {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => { onEscapeRef.current = onEscape; }, [onEscape]);
  useEffect(() => {
    if (!enabled) return undefined;
    const remove = escapeLayers.push(() => onEscapeRef.current());
    // 리스너는 겹침 UI가 하나라도 떠 있는 동안에만 붙인다. 버블 단계라 터미널처럼
    // Esc를 직접 쓰는 위젯이 먼저 처리하고 preventDefault 할 기회를 남긴다.
    if (escapeLayers.size() === 1) window.addEventListener("keydown", closeTopEscapeLayer);
    return () => {
      remove();
      if (escapeLayers.size() === 0) window.removeEventListener("keydown", closeTopEscapeLayer);
    };
  }, [enabled]);
}


/**
 * 겹쳐 뜬 팝오버를 바깥 클릭으로 닫는다. Esc 닫기(`useEscapeToClose`)와 늘 짝으로 쓰이는
 * 나머지 절반이라 같은 자리에 둔다.
 *
 * `areas`에 준 요소 안에서 시작한 포인터는 바깥으로 보지 않는다. 여러 개를 받는 이유는
 * 하단 시트처럼 팝오버가 트리거와 다른 DOM 위치(body 포털)로 빠져나가는 경우가 있어서다.
 * 그때 트리거 하나만 보면 팝오버 안을 눌러도 바깥으로 판정돼 곧바로 닫힌다.
 */
export function useOutsidePointerToClose(onOutside: () => void, enabled: boolean, areas: RefObject<HTMLElement | null>[]) {
  // 콜백과 영역 목록은 렌더마다 새로 만들어지므로 ref로 받아 넘긴다. 리스너는 열림
  // 여부에만 반응해 붙고 떨어진다.
  const latest = useRef({ onOutside, areas });
  latest.current = { onOutside, areas };
  useEffect(() => {
    if (!enabled) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      const { onOutside: dismiss, areas: current } = latest.current;
      if (current.some((area) => area.current?.contains(target))) return;
      dismiss();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [enabled]);
}

/**
 * 뷰포트 좌표로 띄운 겹침 요소(도움말 팝오버·화면 안내 포인터)를 대상 위치에 붙여 둔다.
 * 대상이 움직이는 길은 어느 자리에서나 같다 — 창 크기 변화와, 대상을 품은 스크롤 영역의
 * 스크롤. 그래서 붙었다 떨어지는 구독 한 벌을 자리마다 적는 대신 여기로 모은다.
 *
 * `sync`는 렌더마다 새로 만들어져도 된다(최신 것을 ref로 집어 부른다). 구독은 `enabled`와
 * `observed`에만 반응하므로, 부르는 쪽이 콜백을 memo하지 않아도 리스너가 매 렌더 붙었다
 * 떨어지지 않는다. `observed`를 주면 그 요소 자체의 크기 변화(ResizeObserver)도 함께 듣는다.
 */
export function useAnchoredViewportSync(sync: () => void, enabled = true, observed?: Element | null) {
  const latest = useRef(sync);
  latest.current = sync;
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const run = () => latest.current();
    run();
    window.addEventListener("resize", run);
    // 대상을 품은 스크롤 영역이 body가 아니어서, 캡처 단계로 모든 스크롤을 받는다.
    window.addEventListener("scroll", run, true);
    const observer = observed && typeof ResizeObserver === "function" ? new ResizeObserver(run) : null;
    if (observed) observer?.observe(observed);
    return () => {
      window.removeEventListener("resize", run);
      window.removeEventListener("scroll", run, true);
      observer?.disconnect();
    };
  }, [enabled, observed]);
}

export interface FileDropZone {
  over: boolean;
  dropProps: Partial<Pick<DOMAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">>;
}

/**
 * 파일을 끌어다 놓아 첨부하는 자리. 채팅 화면·세션 상세·AIA 팝업이 모두 "대화 영역 전체가
 * 놓는 자리"라는 같은 규칙을 쓰도록 한 곳에 둔다. 자식 위로 커서가 지날 때마다 dragleave가
 * 오므로 들어온 깊이를 세어 두고 0이 될 때만 표시를 지운다. 안쪽 자리가 이미 받아 간
 * 드롭(preventDefault)은 바깥 자리에서 다시 첨부하지 않고 표시만 정리한다.
 */
export function useFileDropZone(
  onAdd: (files: File[]) => void,
  disabled = false,
  onReject?: (message: string) => void,
): FileDropZone {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const reset = () => {
    depth.current = 0;
    setOver(false);
  };
  const dropProps = disabled ? {} : {
    onDragEnter: (event: React.DragEvent) => {
      if (!draggingFiles(event)) return;
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (draggingFiles(event)) event.preventDefault();
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!draggingFiles(event)) return;
      depth.current -= 1;
      if (depth.current <= 0) reset();
    },
    onDrop: (event: React.DragEvent) => {
      if (!draggingFiles(event)) return;
      const handled = event.defaultPrevented;
      reset();
      if (handled) return;
      event.preventDefault();
      // 폴더는 크기 0짜리 파일로 들어와 빈 파일과 구분되지 않는다. 놓은 자리에서만 알 수
      // 있으므로 여기서 갈라내고, 섞여 있으면 배치를 통째로 거절한다 — 개수·크기 검사와
      // 같은 규칙이라, 무엇이 담기고 무엇이 빠졌는지 헤아릴 필요가 없다.
      // items는 오래된 웹뷰나 합성 이벤트에서 비어 올 수 있다. 그때는 폴더를 가릴 정보가
      // 없을 뿐이므로 파일은 그대로 지나가게 둔다.
      const { files, folderNames } = splitDroppedFolders(event.dataTransfer.items ?? [], event.dataTransfer.files);
      if (folderNames.length > 0) {
        onReject?.(folderDropMessage(folderNames));
        return;
      }
      if (files.length > 0) onAdd(files);
    },
  };
  return { over: over && !disabled, dropProps };
}

function draggingFiles(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

/**
 * 끌어온 파일이 이 자리에 놓일 수 있음을 덮어 알리는 표시. 이미 위치가 잡힌 조상
 * (`.structured-chat`·`.drawer`·`.aia-chat-popup`) 안에서만 쓴다. 그렇지 않은 자리는
 * `chat-drop-zone`을 함께 붙인다 — 그 클래스는 position만 잡아 준다.
 */
export function FileDropOverlay({ label }: { label?: string }) {
  const { text } = useI18n();
  return (
    <div className="chat-file-drop-overlay" aria-hidden="true">
      <Paperclip size={16} />
      <span>{label ?? text("여기에 놓아 첨부", "Drop to attach")}</span>
    </div>
  );
}

/**
 * 겹쳐 뜬 판의 바깥 껍데기. 드로워·모달·다이어그램 확대보기가 저마다 적던 같은 네 줄
 * (배경 div, 배경 누름으로 닫기, 판에서 시작한 누름 막기, `aria-modal`)을 한 벌로 모은다.
 * 클래스 이름과 머리글·본문 구성은 판마다 다르므로 그대로 각자가 정한다.
 *
 * `onBackdropClose`를 주지 않으면 배경 닫기도 모달 의미도 두지 않는다 — 팝아웃 창처럼
 * 그 판이 화면 전체인 경우다. 덮는 배경이 없으면 "바깥"이 없어 닫을 자리도 없고,
 * 보조기술에게 나머지 화면이 가려졌다고 알릴 것도 없다. 둘은 늘 함께 켜지고 꺼진다.
 *
 * 판 안에서 시작한 누름을 배경까지 올리지 않는 이유는, 본문 글자를 끌어 선택하다 배경
 * 위에서 손을 떼는 흔한 동작에 판이 닫히지 않게 하려는 것이다.
 */
export function DialogSurface({ backdropClassName, className, role = "dialog", labelledBy, label, onBackdropClose, surfaceProps, children }: PropsWithChildren<{
  backdropClassName: string;
  className: string;
  role?: string;
  labelledBy?: string;
  label?: string;
  onBackdropClose?: () => void;
  surfaceProps?: DOMAttributes<HTMLElement>;
}>) {
  return (
    <div className={backdropClassName} role="presentation" onMouseDown={onBackdropClose}>
      <section
        className={className}
        role={role}
        aria-modal={onBackdropClose ? true : undefined}
        aria-labelledby={labelledBy}
        aria-label={label}
        onMouseDown={onBackdropClose ? (event) => event.stopPropagation() : undefined}
        {...surfaceProps}
      >
        {children}
      </section>
    </div>
  );
}

/** 겹쳐 뜬 판의 머리글 오른쪽 끝에 붙는 닫기 단추. 세 판이 같은 모양을 쓴다. */
export function DialogCloseButton({ label, onClose, autoFocus = false }: { label: string; onClose: () => void; autoFocus?: boolean }) {
  return (
    <button className="icon-button" type="button" onClick={onClose} aria-label={label} autoFocus={autoFocus}>
      <X size={16} />
    </button>
  );
}

/**
 * 상세 화면의 공통 껍데기. 두 가지 표현을 갖는다.
 * - `overlay`(기본): 목록 위에 덮는 모달 드로워. 배경 클릭과 Esc로 닫힌다.
 * - `panel`: 팝아웃 창처럼 이 상세가 화면 전체인 경우. 덮는 배경도 모달 의미도 없으므로
 *   배경 클릭 닫기와 `aria-modal`, Esc 닫기를 두지 않는다.
 */
export function Drawer({ title, actions, headerContent, onClose, bodyRef, bodyOverlay, footer, dropZone, variant = "overlay", children }: PropsWithChildren<{ title: ReactNode; actions?: ReactNode; headerContent?: ReactNode; onClose: () => void; bodyRef?: Ref<HTMLDivElement>; bodyOverlay?: ReactNode; footer?: ReactNode; dropZone?: FileDropZone; variant?: "overlay" | "panel" }>) {
  const { text } = useI18n();
  const panel = variant === "panel";
  useEscapeToClose(onClose, !panel);
  return (
    <DialogSurface
      backdropClassName={panel ? "drawer-panel" : "drawer-backdrop"}
      className={`drawer${footer ? " drawer-with-footer" : ""}`}
      role={panel ? "region" : "dialog"}
      onBackdropClose={panel ? undefined : onClose}
      surfaceProps={dropZone?.dropProps}
    >
      {dropZone?.over && <FileDropOverlay />}
      <div className="drawer-chrome">
        <header className="drawer-header">
          <div className="drawer-title">{title}</div>
          <div className="drawer-header-actions">
            {actions}
            <DialogCloseButton label={text("닫기", "Close")} onClose={onClose} />
          </div>
        </header>
        {headerContent && <div className="drawer-header-content">{headerContent}</div>}
      </div>
      <div className="drawer-body-shell">
        <div className="drawer-body" ref={bodyRef}>{children}</div>
        {bodyOverlay}
      </div>
      {footer && <div className="drawer-footer">{footer}</div>}
    </DialogSurface>
  );
}

/**
 * 화면 가운데에 띄우는 작은 대화상자. 한 가지 입력만 받는 편집처럼 Drawer를 열기에는
 * 무거운 작업에 쓴다. 배경 클릭과 Esc로 닫히므로 저장 중에는 onClose에서 막아야 한다.
 * `size="wide"`는 여러 칸짜리 폼, `size="full"`은 사용자가 전체 보기를 고른 큰 본문에 쓴다.
 */
export function Modal({ title, onClose, footer, size = "default", elevated = false, children }: PropsWithChildren<{ title: ReactNode; onClose: () => void; footer?: ReactNode; size?: "default" | "wide" | "full"; elevated?: boolean }>) {
  const { text } = useI18n();
  const titleId = useId();
  useEscapeToClose(onClose);
  return (
    <DialogSurface
      backdropClassName={`modal-backdrop${elevated ? " modal-backdrop-elevated" : ""}`}
      className={`modal${size === "default" ? "" : ` ${size}`}`}
      labelledBy={titleId}
      onBackdropClose={onClose}
    >
      <header className="modal-header">
        <div className="modal-title" id={titleId}>{title}</div>
        <DialogCloseButton label={text("닫기", "Close")} onClose={onClose} />
      </header>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </DialogSurface>
  );
}

/**
 * 되돌리기 어려운 작업 앞에 띄우는 확인 대화상자의 요청 형태. 브라우저 기본
 * confirm 대신 쓰므로, 제목·본문·대상 목록·경고를 나눠 받아 무엇이 사라지는지
 * 한눈에 보이게 한다.
 */
export interface ConfirmRequest {
  /** 대화상자 제목. 무엇을 하려는지 짧게 적는다. */
  title: ReactNode;
  /** 본문. 줄바꿈(\n)으로 나눈 각 줄을 문단으로 보여준다. */
  message: string;
  /** 여러 대상을 한 번에 처리할 때 나열하는 이름 목록. */
  items?: string[];
  /** 복구 불가처럼 반드시 읽어야 하는 한 줄 경고. */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 확인과 함께 저장할 선택 항목. 취소할 때는 onConfirm을 호출하지 않는다. */
  checkbox?: {
    label: ReactNode;
    defaultChecked?: boolean;
    onConfirm?: (checked: boolean) => void;
  };
  /** danger면 실행 버튼을 파괴적 동작 색으로 보여준다. */
  tone?: "default" | "danger";
}

/**
 * window.confirm을 대체하는 약속 기반 확인 대화상자. `confirm(...)`이 사용자의
 * 선택을 담은 Promise를 돌려주므로 기존 `if (!confirm(...)) return;` 흐름을 그대로
 * 유지할 수 있다. 반환한 `confirmDialog`를 컴포넌트 트리에 렌더해야 창이 뜬다.
 * 대화상자를 띄운 컴포넌트가 사라지거나 확인 요청이 겹치면 취소(false)로 정리해,
 * 기다리던 호출이 영원히 멈추지 않게 한다.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((accepted: boolean) => void) | null>(null);

  const settle = useCallback((accepted: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(accepted);
  }, []);

  const confirm = useCallback((next: ConfirmRequest) => {
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setRequest(next);
    });
  }, []);

  useEffect(() => () => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(false);
  }, []);

  return {
    confirm,
    confirmDialog: request ? <ConfirmDialog request={request} onSettle={settle} /> : null,
  };
}

function ConfirmDialog({ request, onSettle }: { request: ConfirmRequest; onSettle: (accepted: boolean) => void }) {
  const { text } = useI18n();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [checkboxChecked, setCheckboxChecked] = useState(Boolean(request.checkbox?.defaultChecked));
  // 실행 버튼에 포커스를 두어 Enter로 확인, Esc로 취소가 되게 한다.
  useEffect(() => { confirmRef.current?.focus(); }, []);
  useEffect(() => {
    setCheckboxChecked(Boolean(request.checkbox?.defaultChecked));
  }, [request]);
  const danger = request.tone === "danger";
  const lines = request.message.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <Modal
      title={<>{danger ? <ShieldAlert size={15} /> : <CircleQuestionMark size={15} />}<span>{request.title}</span></>}
      onClose={() => onSettle(false)}
      footer={<>
        <button className="button" type="button" onClick={() => onSettle(false)}>{request.cancelLabel ?? text("취소", "Cancel")}</button>
        <button className={`button ${danger ? "danger" : "primary"}`} type="button" ref={confirmRef} onClick={() => {
          try { request.checkbox?.onConfirm?.(checkboxChecked); }
          finally { onSettle(true); }
        }}>
          {request.confirmLabel ?? text("확인", "Confirm")}
        </button>
      </>}
    >
      <div className="confirm-dialog">
        {lines.map((line, index) => <p key={index}>{line}</p>)}
        {request.items && request.items.length > 0 && (
          <ul className="confirm-dialog-items">
            {request.items.map((item) => <li key={item}><code>{item}</code></li>)}
          </ul>
        )}
        {request.warning && <p className="confirm-dialog-warning"><AlertTriangle size={13} aria-hidden="true" />{request.warning}</p>}
        {request.checkbox && (
          <label className="confirm-dialog-option">
            <input type="checkbox" checked={checkboxChecked} onChange={(event) => setCheckboxChecked(event.target.checked)} />
            <span>{request.checkbox.label}</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

/**
 * 실패 배너. 어떤 요청이 실제로 실패했을 때만 쓴다 — 머리말과 오류코드를 무조건 붙이므로,
 * 실패가 아닌 안내를 여기로 보내면 "무언가 실패했다"는 신호와 문의용 코드가 잘못 붙는다
 * (QA #59). 사전 조건·환경 제한 같은 안내는 `NoticeBanner`.
 */
export function ErrorBanner({ message }: { message: string }) {
  const { text } = useI18n();
  const banner = useRef<HTMLDivElement | null>(null);
  /**
   * 실패는 그 자리에서 읽혀야 한다. 긴 패널의 아래쪽을 보고 있을 때 배너가 목록 위에 생기면
   * DOM에는 있지만 현재 화면에는 없어, 사용자 눈에는 "아무 일도 일어나지 않은 것"으로
   * 보였다(QA #88 — 문서 트리거 활성 변경 실패). `block: "nearest"`라 이미 보이는 배너는
   * 화면을 움직이지 않는다.
   */
  useEffect(() => {
    banner.current?.scrollIntoView({ block: "nearest" });
  }, [message]);
  return <div className="error-banner" ref={banner}><strong>{text("요청을 처리하지 못했습니다.", "The request could not be completed.")} <code>{stableErrorCode(message)}</code></strong><span>{message}</span></div>;
}

function stableErrorCode(message: string): string {
  if (/권한|forbidden|permission/i.test(message)) return "APP_ACCESS_DENIED";
  if (/보안 저장소|secure storage/i.test(message)) return "APP_CREDENTIALS";
  if (/찾을 수 없|not found/i.test(message)) return "APP_NOT_FOUND";
  if (/시간이 초과|timeout/i.test(message)) return "APP_TIMEOUT";
  if (/충돌|conflict|already|계정을 전환할 수 없|전환될 때까지 대기/i.test(message)) return "APP_CONFLICT";
  if (/연결|websocket|network/i.test(message)) return "APP_CONNECTION";
  if (/입력|invalid/i.test(message)) return "APP_INVALID_INPUT";
  // 공급자·플랫폼이 그 기능을 제공하지 않아 거절된 요청은 런타임 장애가 아니다.
  if (/지원하지 않|unsupported|not supported/i.test(message)) return "APP_UNSUPPORTED";
  return "APP_RUNTIME";
}

/**
 * 화면 한 벌이 쓰는 비동기 동작 봉투 — 무엇이 도는지 `busy`에 적고, 이전 실패 문구를
 * 비우고, 실행하고, 실패하면 문구를 남기고, 끝나면 `busy`를 되돌린다. 설정 카드와 사이드바가
 * 저마다 같은 열 줄을 적고 있었고, 한 갈래에서 `finally`를 빠뜨리면 그 화면이 busy에 갇혀
 * 모든 버튼이 눌리지 않는 상태로 남는다. 봉투는 여기 한 벌만 둔다.
 *
 * `busy` 토큰은 어느 항목이 도는지 구분해야 하는 화면(행마다 버튼이 있는 목록)을 위한
 * 것이다. 한 번에 하나만 도는 화면은 아무 토큰이나 주고 `busy !== null`로 읽으면 된다.
 *
 * **동시 실행 차단은 봉투에 넣지 않는다.** 무엇을 막을지가 화면마다 다르다 — 확인
 * 대화상자를 거치는 삭제처럼 일부러 막지 않는 갈래가 있어, 여기서 일괄로 막으면 그 화면의
 * 동작이 달라진다. 호출부의 `busy` 확인은 그대로 둔다.
 */
export function useBusyAction<T extends string = string>() {
  const [busy, setBusy] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (token: T, action: () => Promise<void>) => {
    setBusy(token);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, setError, run };
}

/** 실패가 아닌 안내 배너. 실패 머리말도 오류코드도 붙이지 않고 문장만 보인다. */
export function NoticeBanner({ message }: { message: string }) {
  return <div className="notice-banner" role="note"><span>{message}</span></div>;
}

// 도움말 물음표 버튼과 팝오버 한 벌(배치 규칙·좁은 화면 시트 판정 포함)은 HelpHint.tsx가
// 소유한다. 설정·워크플로 등 여러 화면이 Shared에서 가져다 쓰고 있어, 가져오는 자리를
// 옮기지 않도록 이름만 여기서 다시 내보낸다.
export { HelpHint } from "./HelpHint";

// 승인 카드 한 벌(독·카드·질문지·종류별 문구)은 ApprovalPrompts.tsx가 소유한다. 채팅 화면·
// 세션 상세·AIA 팝업이 모두 Shared에서 가져다 쓰고 있어, 가져오는 자리를 옮기지 않도록
// 이름만 여기서 다시 내보낸다.
export { ChatApprovalCard, ChatApprovalDock } from "./ApprovalPrompts";
export type { ChatApprovalDecider, ChatApprovalPrompt } from "./ApprovalPrompts";

// 실행설정 바(전송 버튼 위)에서 컨텍스트 사용량을 계정 사용량과 같은 게이지로 보여준다.
// 창 크기를 모르면(공급자가 알려주지 않았거나 압축 직후) 토큰 수만 적는다.
export function ChatContextMeter({ usedTokens, windowTokens }: { usedTokens: number | null; windowTokens: number | null }) {
  const { text } = useI18n();
  if (usedTokens == null) return null;
  const percent = windowTokens ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const level = percent == null ? "" : percent >= 90 ? " critical" : percent >= 75 ? " warning" : "";
  return <div className={`chat-context-meter${level}`} title={text("마지막 요청 기준 컨텍스트 사용량 추정", "Estimated context usage based on last request")}>
    <em>{text("컨텍스트", "Context")}</em>
    {percent != null && <div className="progress" role="img" aria-label={`${text("컨텍스트 사용량", "Context usage")} ${percent}%`}><span style={{ width: `${percent}%` }} /></div>}
    <b>{percent != null ? `${percent}% · ${formatTokenCount(usedTokens)}/${formatTokenCount(windowTokens!)}` : `${formatTokenCount(usedTokens)} ${text("토큰", "tokens")}`}</b>
  </div>;
}

function formatTokenCount(tokens: number): string { return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(tokens); }

export function ChatQueueList({
  items,
  onRemove,
  onRecall,
}: {
  items: QueuedChatMessage[];
  onRemove: (messageId: string) => void;
  onRecall: (item: QueuedChatMessage) => void;
}) {
  const { text } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="chat-queue" aria-label={text("대기 중인 메시지", "Queued messages")}>
      <header>{text("대기열", "Queue")} {items.length}{text("개 · 응답이 끝나면 순서대로 전송됩니다", " items · sent in order when response completes")}</header>
      {items.map((item, index) => (
        <div className="chat-queue-item" key={item.id}>
          <span className="chat-queue-index">{index + 1}</span>
          <p title={item.text || item.attachments.map((file) => file.name).join(", ")}>{item.text || text("첨부 파일", "Attachments")}{item.attachments.length > 0 && <small><Paperclip size={11} /> {item.attachments.map((file) => file.name).join(", ")}</small>}</p>
          <button type="button" title={text("입력창으로 되돌리기", "Restore to input")} aria-label={text("입력창으로 되돌리기", "Restore to input")} onClick={() => onRecall(item)}><Undo2 size={13} /></button>
          <button type="button" title={text("대기열에서 삭제", "Remove from queue")} aria-label={text("대기열에서 삭제", "Remove from queue")} onClick={() => onRemove(item.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

/**
 * 응답 중에 쓴 입력을 어디로 보낼지 고르는 공용 메뉴. 트리거 모양만 화면마다 다르고
 * 선택지와 동작은 어디서나 같아야 하므로 한자리에서 그린다.
 */
export function ChatSendActionMenu({
  hasDraft,
  sendDisabled,
  canDeliver,
  trigger,
  onOpenChange,
  onQueue,
  onDeliver,
  onInterrupt,
}: {
  hasDraft: boolean;
  sendDisabled: boolean;
  canDeliver: boolean;
  /** 메뉴를 여는 버튼. 그 화면의 전송 버튼과 같은 자리·같은 생김새로 준다. */
  trigger: { className: string; title?: string; content: ReactNode };
  /** 팝오버가 열리고 닫히는 순간. 열려 있는 동안 이 자리를 지켜야 하는 화면이 쓴다. */
  onOpenChange?: (open: boolean) => void;
  onQueue: () => void;
  onDeliver: () => void;
  onInterrupt: () => void;
}) {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openChangeRef = useRef(onOpenChange);
  openChangeRef.current = onOpenChange;
  /** 열고 닫을 때는 항상 이 함수를 쓴다. 알리지 않고 바꾸면 자리를 지켜 주는 화면이 어긋난다. */
  const changeOpen = (next: boolean) => {
    setOpen(next);
    openChangeRef.current?.(next);
  };
  // 초안이 사라져 중단 버튼으로 바뀌거나 화면을 떠나면 이 메뉴 자체가 사라진다.
  // 그때도 닫혔음을 알려, 자리를 지켜 주던 화면이 열린 상태로 굳지 않게 한다.
  useEffect(() => () => openChangeRef.current?.(false), []);
  useEffect(() => {
    if (!hasDraft) changeOpen(false);
  }, [hasDraft]);
  useEscapeToClose(() => changeOpen(false), open);
  useOutsidePointerToClose(() => changeOpen(false), open, [rootRef]);

  const choose = (action: () => void) => {
    changeOpen(false);
    action();
  };

  return <div className="chat-send-action-menu" ref={rootRef}>
      <button
        className={trigger.className}
        type="button"
        title={trigger.title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger.content}
      </button>
      {open && <div className="chat-send-action-popover" role="menu">
        <button type="button" role="menuitem" onClick={() => choose(onQueue)} disabled={sendDisabled}><span><strong>{text("대기열 추가", "Add to queue")}</strong><small>{text("현재 응답이 끝난 뒤 순서대로 전송", "Send in order after current response finishes")}</small></span><Check size={13} /></button>
        <button type="button" role="menuitem" onClick={() => choose(onDeliver)} disabled={sendDisabled || !canDeliver}><span><strong>{text("작업 중 전달", "Deliver during task")}</strong><small>{canDeliver ? text("중단하지 않고 지금 하는 작업에 바로 전달", "Deliver directly to running task without interrupting") : text("이 공급자는 진행 중인 작업에 전달할 수 없습니다", "This provider cannot deliver during running tasks")}</small></span></button>
        <button className="danger" type="button" role="menuitem" onClick={() => choose(onInterrupt)}><span><strong>{text("응답 중단", "Stop response")}</strong><small>{text("지금 응답만 멈추고 쓴 내용은 그대로 둡니다", "Stop only current response and keep written contents")}</small></span></button>
      </div>}
    </div>;
}

export function ChatBusyComposerActions({
  hasDraft,
  sendDisabled,
  sending,
  canDeliver,
  onOpenChange,
  onInterrupt,
  onQueue,
  onDeliver,
}: {
  hasDraft: boolean;
  sendDisabled: boolean;
  sending: boolean;
  canDeliver: boolean;
  onOpenChange?: (open: boolean) => void;
  onInterrupt: () => void;
  onQueue: () => void;
  onDeliver: () => void;
}) {
  const { text } = useI18n();
  if (!hasDraft) {
    return <button className="button danger-subtle chat-stop-action" type="button" onClick={onInterrupt}><Square size={13} />{text("중단", "Stop")}</button>;
  }

  return <ChatSendActionMenu
    hasDraft={hasDraft}
    sendDisabled={sendDisabled}
    canDeliver={canDeliver}
    trigger={{
      className: "button primary chat-send-action-trigger",
      content: <>{sending ? text("첨부 중…", "Attaching…") : text("대기열 추가", "Add to queue")}<ChevronDown size={13} /></>,
    }}
    onOpenChange={onOpenChange}
    onQueue={onQueue}
    onDeliver={onDeliver}
    onInterrupt={onInterrupt}
  />;
}

/** 설정 화면 공용 on/off 스위치. 체크박스 대신 `role="switch"`로 상태를 읽어 준다. */
export function AppToggle({ checked, disabled = false, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={`app-toggle${checked ? " checked" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="app-toggle-track" aria-hidden="true"><i /></span>
    </button>
  );
}

/**
 * 워크플로 계약이 선언한 입력 하나를 그리는 컨트롤. 워크플로 화면의 즉시 실행과 반복
 * 요청 편집기가 같은 폼을 써야 저장한 값이 실행 화면과 다르게 보이지 않는다.
 */
export function WorkflowInputControl({ name, field, value, onChange, invalid = false, choices, multiple = false }: {
  name: string;
  field: WorkflowInputField;
  value: string;
  onChange: (value: string) => void;
  /** 실행을 막은 필수 입력. 어느 칸을 채워야 하는지 테두리로 짚어 준다. */
  invalid?: boolean;
  /** 문자열 입력을 자유 입력 대신 저장값이 분명한 selectbox로 제한할 때 쓸 선택지. */
  choices?: { value: string; label: string }[] | null;
  /** 선택지에서 여럿을 고르는 칸. 값은 쉼표로 이어 붙인 한 문자열로 오간다. */
  multiple?: boolean;
}) {
  const { text } = useI18n();
  // 계약이 표시 이름을 주면 그것을 제목으로 쓰고 키는 함께 작게 남긴다. 키는 AIA와
  // 사용자가 같은 입력을 가리킬 때 쓰는 이름이라 화면에서 사라지면 안 된다.
  const title = field.label?.trim() ? field.label : name;
  // 제목과 필수 표시를 한 flex 항목으로 묶는다. 각각을 label의 자식으로 두면 세로형
  // 워크플로 입력 레이아웃에서 별도 행으로 갈라져 별표만 덩그러니 보인다.
  const label = <>
    <span className="workflow-input-heading">
      <span>{title}</span>
      {field.required && <span className="workflow-input-required" aria-hidden="true">*</span>}
    </span>
    {field.label?.trim() && <small className="workflow-input-key">{name}</small>}
    {field.description && <small>{field.description}</small>}
  </>;
  const missingChoice = choices != null && value !== "" && !choices.some((choice) => choice.value === value);
  const className = invalid || missingChoice ? "workflow-input-invalid" : undefined;
  // 선택지를 넘겨받은 입력과 계약이 enum으로 선언한 입력은 같은 select를 그린다. 빈 칸의
  // 안내 문구와 목록만 다르므로 그 둘만 갈라 두고, 나머지(라벨·필수 표시·유효성 속성)는
  // 한 벌로 둔다. 갈라 두면 한쪽에만 속성을 더해 두 입력이 다르게 읽히기 쉽다.
  const selectChoices = choices ?? (field.type === "enum"
    ? (field.values ?? []).map((option) => ({ value: option, label: option }))
    : null);
  // 여럿을 고르는 칸은 select 대신 체크박스 무리를 그린다. select multiple은 화면에서
  // 몇 개를 골랐는지 읽기 어렵고, 고르는 수가 두셋뿐이라 펼쳐 두는 편이 낫다.
  if (multiple && selectChoices) {
    const picked = value.split(",").map((item) => item.trim()).filter(Boolean);
    const toggle = (model: string, on: boolean) => {
      // 고른 순서가 아니라 선택지 순서로 저장한다. 같은 조합이 늘 같은 문자열이 되어야
      // 저장본을 견줄 때 순서만 다른 값이 바뀐 것으로 읽히지 않는다.
      const next = selectChoices
        .map((choice) => choice.value)
        .filter((candidate) => (candidate === model ? on : picked.includes(candidate)));
      onChange(next.join(","));
    };
    return <fieldset className={`workflow-input-multi${className ? ` ${className}` : ""}`}>
      <legend>{label}</legend>
      {selectChoices.length === 0
        ? <small>{text("고를 모델이 없습니다. 연결을 켜고 주소를 저장하세요.", "No models to choose. Turn the connection on and save its address.")}</small>
        : selectChoices.map((choice) => <label className="workflow-input-boolean" key={choice.value}>
          <input
            type="checkbox"
            checked={picked.includes(choice.value)}
            onChange={(event) => toggle(choice.value, event.target.checked)}
          />
          <span>{choice.label}</span>
        </label>)}
    </fieldset>;
  }
  if (selectChoices) {
    const placeholder = choices != null
      ? (field.required ? text("선택", "Select") : text("기본 모델", "Default model"))
      : text("선택", "Select");
    return <label className={className}>{label}<select value={value} aria-required={field.required || undefined} aria-invalid={invalid || missingChoice || undefined} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder}</option>
      {missingChoice && <option value={value} disabled>{text(`유효하지 않은 저장값 · ${value}`, `Invalid saved value · ${value}`)}</option>}
      {selectChoices.map((choice) => <option value={choice.value} key={choice.value}>{choice.label}</option>)}
    </select></label>;
  }
  if (field.type === "boolean") {
    return <label className={`workflow-input-boolean${invalid ? " workflow-input-invalid" : ""}`}>
      <input type="checkbox" checked={value === "true"} onChange={(event) => onChange(String(event.target.checked))} />
      {label}
    </label>;
  }
  return <label className={className}>{label}<input
    type={field.type === "number" ? "number" : "text"}
    value={value}
    aria-required={field.required || undefined}
    aria-invalid={invalid || undefined}
    onChange={(event) => onChange(event.target.value)}
  /></label>;
}
