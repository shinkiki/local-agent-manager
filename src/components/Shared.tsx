import { useCallback, useEffect, useId, useRef, useState, type PropsWithChildren, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, CircleQuestionMark, Inbox, Maximize2, Paperclip, ShieldAlert, Square, Undo2, X } from "lucide-react";
import { sourceName } from "../lib/format";
import { closesTopEscapeLayer, createEscapeLayerStack } from "../lib/escapeLayers";
import { CopyAction } from "./CopyAction";
import { MarkdownPreview } from "./MarkdownPreview";
import type { ChatApprovalDecision, ChatApprovalQuestion, ProviderId, QueuedChatMessage, WorkflowInputField } from "../types";
import { useI18n } from "../lib/i18n";

export function SourceBadge({ source }: { source: ProviderId }) {
  return <span className={`source-badge source-${source}`}>{sourceName(source)}</span>;
}

// 타륜 회전: 스포크가 45° 간격이라 45°의 배수에서 멈춘 그림은 정지 상태와 완전히 같다.
// 감속은 그 배수 자리까지 미끄러지게 해, 애니메이션을 걷어내도 각도가 튀지 않는다.
const WHEEL_SPIN_PERIOD_MS = 1_600;
const WHEEL_SPOKE_STEP_DEG = 45;
// 등속 회전 속도(225°/s)에서 그대로 이어받는 감속. 이징 시작 기울기(약 2.75)와 평균
// 활주각(약 67°)을 곱한 초기 속도가 등속 속도에 맞아, 멈추기 시작할 때 튀지 않는다.
const WHEEL_STOP_MS = 900;
const WHEEL_STOP_EASING = "cubic-bezier(.24, .66, .34, 1)";

// 타륜이 돌 때 배경 판에 드는 바다. 회전이 시작되면 서서히 배어들고, 감속이 끝나는
// 시점에 맞춰 서서히 빠진다(App.css의 opacity 전이). 파도 한 겹은 로고 폭(64)보다 넓게
// 그려 두고 한 주기만큼 옆으로 흐르게 해, 이어 붙는 지점이 보이지 않는다.
const SEA_FAR_PERIOD = 32;
const SEA_NEAR_PERIOD = 24;

/**
 * 파도 한 겹의 경로. `x = -64`부터 `128`까지 사인 모양 능선을 깔고 로고 밑변 아래까지
 * 채워 물에 잠긴 면을 만든다. 이차 베지에는 제어점 높이의 절반까지만 솟으므로 진폭의
 * 두 배를 제어점으로 준다.
 */
function seaWavePath(baseY: number, amplitude: number, period: number): string {
  const half = period / 2;
  const control = period / 4;
  const crest = ` q ${control} ${-amplitude * 2} ${half} 0 q ${control} ${amplitude * 2} ${half} 0`;
  let path = `M -64 ${baseY}`;
  for (let x = -64; x < 128; x += period) path += crest;
  return `${path} L 128 66 L -64 66 Z`;
}

/** 회전 중인 타륜의 현재 각도(0~360). 등속·감속 어느 쪽이든 실제 그려진 행렬에서 읽는다. */
function wheelAngleDeg(node: SVGGElement): number {
  const { transform } = getComputedStyle(node);
  if (!transform || transform === "none") return 0;
  const matrix = transform.slice(transform.indexOf("(") + 1, -1).split(",").map(Number);
  // matrix(a, b, ...) / matrix3d(m11, m12, ...) 모두 앞의 두 값이 Z축 회전을 담는다.
  if (matrix.length < 4 || matrix.slice(0, 2).some(Number.isNaN)) return 0;
  return (Math.atan2(matrix[1], matrix[0]) * (180 / Math.PI) + 360) % 360;
}

/** 타륜 로고. `spinning`이면 림과 스포크만 돌아 새로고침이 진행 중임을 알린다(허브의 `>`와 배경 판은 고정). */
export function LogoMark({ size = 37, spinning = false }: { size?: number; spinning?: boolean }) {
  const wheel = useRef<SVGGElement | null>(null);
  const rotation = useRef<Animation | null>(null);
  // 감속이 끝날 때까지는 파도도 계속 흘러야 물이 빠지는 것처럼 보인다. 멈춘 뒤에는
  // 애니메이션을 걷어 유휴 상태의 로고가 매 프레임을 먹지 않게 한다.
  const [settling, setSettling] = useState(false);
  // useId 값에는 콜론이 섞여 있다. url(#…) 참조에 그대로 쓰지 않고 영숫자만 남긴다.
  const markId = useId().replace(/[^a-zA-Z0-9]/g, "");

  // CSS 애니메이션은 클래스가 빠지는 순간 각도가 0으로 되돌아가 회전이 끊긴 것처럼
  // 보인다. 회전을 Web Animations로 잡아 두면 멈출 때 현재 각도에서 이어 감속할 수 있다.
  // Element.animate가 없거나 동작 최소화를 켠 환경에서는 App.css의 CSS 회전이 대신 돈다.
  useEffect(() => {
    const node = wheel.current;
    if (!node || typeof node.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const previous = rotation.current;
    const running = previous?.playState === "running" ? previous : null;
    const angle = running ? wheelAngleDeg(node) : 0;
    running?.cancel();
    if (spinning) {
      setSettling(false);
      // 감속 중에 다시 눌렸으면 그 각도에서 이어 돈다.
      rotation.current = node.animate(
        [{ transform: `rotate(${angle}deg)` }, { transform: `rotate(${angle + 360}deg)` }],
        { duration: WHEEL_SPIN_PERIOD_MS, iterations: Infinity, easing: "linear" },
      );
      return;
    }
    if (!running) return;
    // 다음 스포크 자리를 하나 더 지나 멈춘다(활주 45~90°).
    const target = (Math.floor(angle / WHEEL_SPOKE_STEP_DEG) + 2) * WHEEL_SPOKE_STEP_DEG;
    const stopping = node.animate(
      [{ transform: `rotate(${angle}deg)` }, { transform: `rotate(${target}deg)` }],
      { duration: WHEEL_STOP_MS, easing: WHEEL_STOP_EASING, fill: "forwards" },
    );
    rotation.current = stopping;
    setSettling(true);
    void stopping.finished.then(() => {
      // 멈춘 각도가 정지 그림과 같으므로 애니메이션을 걷어내 남은 fill을 정리한다.
      if (rotation.current !== stopping) return;
      rotation.current = null;
      stopping.cancel();
      setSettling(false);
    }).catch(() => {
      // 다음 회전이 취소한 것이다. 그 회전이 각도를 이어받았으므로 할 일이 없다.
    });
  }, [spinning]);

  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Agent Manager 로고">
      <defs>
        <linearGradient id="lmBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#131e2c" />
          <stop offset="1" stopColor="#0a121c" />
        </linearGradient>
        {/* 물빛은 위가 밝고 아래가 배경 판으로 잠겨, 파도가 판 안에서 일어난 것처럼 읽힌다. */}
        <linearGradient id={`${markId}-sea`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d8fa8" stopOpacity=".5" />
          <stop offset="1" stopColor="#0d2233" stopOpacity=".9" />
        </linearGradient>
        {/* 배경 판과 같은 둥근 사각형으로 잘라 파도가 판 밖으로 새지 않는다. */}
        <clipPath id={`${markId}-plate`}>
          <rect x="1" y="1" width="62" height="62" rx="14" />
        </clipPath>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="14" fill="url(#lmBg)" />
      <g
        className={`logo-mark-sea${spinning ? " visible" : ""}${spinning || settling ? " moving" : ""}`}
        clipPath={`url(#${markId}-plate)`}
        aria-hidden="true"
      >
        {/* 수면 전체가 느리게 숨 쉬고, 그 위에서 두 겹이 서로 다른 속도로 흘러 깊이를 만든다. */}
        <g className="logo-mark-sea-swell">
          <path className="logo-mark-sea-layer far" d={seaWavePath(43, 1.5, SEA_FAR_PERIOD)} fill="#18455c" fillOpacity=".55" />
          <path className="logo-mark-sea-layer near" d={seaWavePath(48, 2.2, SEA_NEAR_PERIOD)} fill={`url(#${markId}-sea)`} />
          {/* 물마루에 놋빛을 아주 옅게 얹어 바다도 타륜과 같은 팔레트에 머문다. */}
          <path className="logo-mark-sea-layer near" d={seaWavePath(48, 2.2, SEA_NEAR_PERIOD)} fill="none" stroke="#f0b054" strokeOpacity=".2" strokeWidth=".6" />
        </g>
      </g>
      <g transform="translate(32 32) scale(0.0735) translate(-512 -512)">
        <g className={`logo-mark-wheel${spinning ? " spinning" : ""}`} ref={wheel} stroke="#f0b054" fill="none">
          <circle cx="512" cy="512" r="196" strokeWidth="42" />
          <g strokeWidth="52" strokeLinecap="round">
            <path d="M512 294 L512 190" />
            <path d="M666.1 357.9 L739.7 284.3" />
            <path d="M730 512 L834 512" />
            <path d="M666.1 666.1 L739.7 739.7" />
            <path d="M512 730 L512 834" />
            <path d="M357.9 666.1 L284.3 739.7" />
            <path d="M294 512 L190 512" />
            <path d="M357.9 357.9 L284.3 284.3" />
          </g>
          <g strokeWidth="26">
            <path d="M512 404 L512 332" />
            <path d="M588.4 435.6 L639.3 384.7" />
            <path d="M620 512 L692 512" />
            <path d="M588.4 588.4 L639.3 639.3" />
            <path d="M512 620 L512 692" />
            <path d="M435.6 588.4 L384.7 639.3" />
            <path d="M404 512 L332 512" />
            <path d="M435.6 435.6 L384.7 384.7" />
          </g>
        </g>
        <circle cx="512" cy="512" r="122" fill="#f0b054" />
        <path d="M478 458 L550 512 L478 566" fill="none" stroke="#0e1724" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <rect x="1.5" y="1.5" width="61" height="61" rx="13.5" fill="none" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="1" />
    </svg>
  );
}

/** AIA 마크: 나침반 베젤(링·4방위 틱) 중앙에 타륜 허브와 같은 `>` 표식을 2시(북동) 방향으로 회전 — 프롬프트 셰브론이 곧 나침반 바늘이 된다. viewBox를 꽉 채워 소형 컨테이너에서도 여백 없이 읽힌다. */
export function AiaMark({ size = 16 }: { size?: number }) {
  // 바늘이 배회하는 애니메이션(App.css)은 이 표식이 놓인 자리에 따라 켜진다.
  // 회전은 항상 정지 상태와 같은 북동쪽에서 시작하되, 첫 회전 시점과 한 바퀴 도는 데 걸리는
  // 시간을 인스턴스마다 흩어 두어 여러 나침반이 계속 같은 방향을 가리키지 않게 한다.
  const [wander] = useState(() => ({
    delay: `${(Math.random() * 2.4).toFixed(2)}s`,
    duration: `${(11 + Math.random() * 8).toFixed(1)}s`,
  }));
  return (
    <svg className="aia-mark" width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
      <circle cx="16" cy="16" r="14.2" fill="none" stroke="currentColor" strokeWidth="2.6" />
      <g stroke="currentColor" strokeWidth="2.2" fill="none">
        <path d="M16 4.1 L16 6.6" />
        <path d="M27.9 16 L25.4 16" />
        <path d="M16 27.9 L16 25.4" />
        <path d="M4.1 16 L6.6 16" />
      </g>
      <g className="aia-mark-needle" style={{ animationDelay: wander.delay, animationDuration: wander.duration }}>
        <path d="M12.6 9.4 L20.4 16 L12.6 22.6" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-45 16 16) translate(1.8 0)" />
      </g>
    </svg>
  );
}


export function LoadingState({ label = "로컬 데이터를 읽고 있습니다" }: { label?: string }) {
  return (
    <div className="state-panel">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
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
  return (
    <div className="path-field">
      <input
        id={id}
        type="text"
        value={value}
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
 * 상세 화면의 공통 껍데기. 두 가지 표현을 갖는다.
 * - `overlay`(기본): 목록 위에 덮는 모달 드로워. 배경 클릭과 Esc로 닫힌다.
 * - `panel`: 팝아웃 창처럼 이 상세가 화면 전체인 경우. 덮는 배경도 모달 의미도 없으므로
 *   배경 클릭 닫기와 `aria-modal`, Esc 닫기를 두지 않는다.
 */
export function Drawer({ title, actions, headerContent, onClose, bodyRef, bodyOverlay, footer, variant = "overlay", children }: PropsWithChildren<{ title: ReactNode; actions?: ReactNode; headerContent?: ReactNode; onClose: () => void; bodyRef?: Ref<HTMLDivElement>; bodyOverlay?: ReactNode; footer?: ReactNode; variant?: "overlay" | "panel" }>) {
  const { text } = useI18n();
  const panel = variant === "panel";
  useEscapeToClose(onClose, !panel);
  return (
    <div
      className={panel ? "drawer-panel" : "drawer-backdrop"}
      role="presentation"
      onMouseDown={panel ? undefined : onClose}
    >
      <section
        className={`drawer${footer ? " drawer-with-footer" : ""}`}
        role={panel ? "region" : "dialog"}
        aria-modal={panel ? undefined : true}
        onMouseDown={panel ? undefined : (event) => event.stopPropagation()}
      >
        <div className="drawer-chrome">
          <header className="drawer-header">
            <div className="drawer-title">{title}</div>
            <div className="drawer-header-actions">
              {actions}
              <button className="icon-button" type="button" onClick={onClose} aria-label={text("닫기", "Close")}>
                <X size={16} />
              </button>
            </div>
          </header>
          {headerContent && <div className="drawer-header-content">{headerContent}</div>}
        </div>
        <div className="drawer-body-shell">
          <div className="drawer-body" ref={bodyRef}>{children}</div>
          {bodyOverlay}
        </div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </section>
    </div>
  );
}

/**
 * 화면 가운데에 띄우는 작은 대화상자. 한 가지 입력만 받는 편집처럼 Drawer를 열기에는
 * 무거운 작업에 쓴다. 배경 클릭과 Esc로 닫히므로 저장 중에는 onClose에서 막아야 한다.
 * `size="wide"`는 여러 칸짜리 폼이나 본문 편집기가 들어가 기본 폭이 좁을 때만 쓴다.
 */
export function Modal({ title, onClose, footer, size = "default", elevated = false, children }: PropsWithChildren<{ title: ReactNode; onClose: () => void; footer?: ReactNode; size?: "default" | "wide"; elevated?: boolean }>) {
  const titleId = useId();
  useEscapeToClose(onClose);
  return (
    <div className={`modal-backdrop${elevated ? " modal-backdrop-elevated" : ""}`} role="presentation" onMouseDown={onClose}>
      <section className={`modal${size === "wide" ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title" id={titleId}>{title}</div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기"><X size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </section>
    </div>
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

export function ErrorBanner({ message }: { message: string }) {
  const { text } = useI18n();
  return <div className="error-banner"><strong>{text("요청을 처리하지 못했습니다.", "The request could not be completed.")} <code>{stableErrorCode(message)}</code></strong><span>{message}</span></div>;
}

const HELP_SHEET_QUERY = "(max-width: 760px)";
const isHelpSheetViewport = () => typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia(HELP_SHEET_QUERY).matches;

/**
 * 동그라미 물음표 버튼과 상세 설명 팝오버. 화면에 항상 긴 안내를 깔지 않고, 필요한
 * 사람이 눌렀을 때만 동작 설명을 연다. 바깥 클릭과 Esc로 닫는다.
 */
export function HelpHint({ label, title, footer, popoverClassName, children }: PropsWithChildren<{
  label: string;
  title?: ReactNode;
  footer?: ReactNode;
  popoverClassName?: string;
}>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  // 좁은 화면에서는 팝오버가 하단 시트로 바뀐다. 트리거 자리에 그대로 두면 상단바나 실행설정
  // 카드처럼 z-index를 가진 조상의 스택 문맥에 갇혀 본문 뒤로 숨으므로 body로 내보낸다.
  const [sheet, setSheet] = useState(isHelpSheetViewport);
  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(HELP_SHEET_QUERY);
    const sync = () => setSheet(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [open]);
  useEscapeToClose(() => setOpen(false), open);
  // 하단 시트일 때는 팝오버가 트리거와 다른 DOM 위치에 있으므로 두 영역을 함께 넘긴다.
  useOutsidePointerToClose(() => setOpen(false), open, [rootRef, popoverRef]);

  const popover = open
    ? <span className={`help-hint-popover${popoverClassName ? ` ${popoverClassName}` : ""}`} role="note" ref={popoverRef}>
        {title && <strong>{title}</strong>}
        <small>{children}</small>
        {footer && <span
          className="help-hint-footer"
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("button")) setOpen(false);
          }}
        >{footer}</span>}
      </span>
    : null;

  return <span className="help-hint" ref={rootRef}>
    <button
      className="help-hint-trigger"
      type="button"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={() => setOpen((current) => !current)}
    >
      <CircleQuestionMark size={14} aria-hidden="true" />
    </button>
    {popover && (sheet ? createPortal(popover, document.body) : popover)}
  </span>;
}

export interface ChatApprovalPrompt {
  id: string;
  /**
   * `plan`이면 계획 문서를 읽고 실행 여부를 고르는 카드, `question`이면 에이전트가
   * 되물은 질문에 답하는 카드다. 그 밖에는 권한 확인 카드.
   */
  kind: string;
  title: string;
  detail: string;
  options: ChatApprovalDecision[];
  interactive: boolean;
  resolved: ChatApprovalDecision | null;
  /** `kind`가 `question`일 때 고를 질문지. */
  questions: ChatApprovalQuestion[];
  /** 답을 보낸 뒤 백엔드가 되돌려 준 "실제로 전달된 답"(질문 원문 -> 답). */
  answers: Record<string, string>;
}

export type ChatApprovalDecider = (id: string, decision: ChatApprovalDecision, answers?: Record<string, string>) => void;

/**
 * 승인 카드를 모아 두는 채팅 하단 독. 계획 검토처럼 본문이 긴 카드가 대화를 가려
 * 읽을 수 없다는 문제가 있어, 헤더에서 통째로 접었다 펼 수 있게 한다. 접힌 동안에도
 * 무엇이 기다리는지 알 수 있도록 카드 제목을 한 줄 요약으로 남긴다.
 */
export function ChatApprovalDock({ className = "chat-approval-dock", label = "응답을 기다리는 권한 요청", title, hint, prompts, onDecision }: {
  className?: string;
  label?: string;
  title: string;
  hint: string;
  prompts: ChatApprovalPrompt[];
  onDecision: ChatApprovalDecider;
}) {
  const { text } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const ids = prompts.map((prompt) => prompt.id).join("|");
  // 새 요청이 도착하면 접힌 상태를 풀어, 접어 둔 채로 승인 대기를 놓치지 않게 한다.
  useEffect(() => { setCollapsed(false); }, [ids]);
  if (prompts.length === 0) return null;
  return (
    <div className={`${className}${collapsed ? " approval-dock-collapsed" : ""}`} aria-label={label}>
      <header>
        <div className="approval-dock-heading"><strong>{title}</strong><span>{hint}</span></div>
        <button
          className="approval-dock-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? "펼치기" : "접기"}
          {prompts.length > 1 && <em>{text(`${prompts.length}건`, `${prompts.length} items`)}</em>}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </header>
      {collapsed
        ? <p className="approval-dock-summary">{prompts.map((prompt) => prompt.title).join(" · ")}</p>
        : prompts.map((prompt) => <ChatApprovalCard prompt={prompt} onDecision={onDecision} key={prompt.id} />)}
    </div>
  );
}

export function ChatApprovalCard({ prompt, onDecision }: { prompt: ChatApprovalPrompt; onDecision: ChatApprovalDecider }) {
  // 계획 검토는 승인할 권한이 아니라 읽어야 할 문서라, 요청 JSON 대신 계획 본문을 그대로 그린다.
  const plan = prompt.kind === "plan";
  // 질문지가 비어 있으면(리플레이 버퍼가 잘려 재구성된 카드) 고를 것이 없으므로 일반 카드로 둔다.
  const questions = prompt.kind === "question" ? prompt.questions : [];
  // 고른 선택지는 라벨 목록으로 들고 있다가 보낼 때만 한 줄로 잇는다. 이어 붙인 문자열을
  // 상태로 두면 라벨에 콤마가 든 선택지("예, 그대로 둡니다")를 다시 갈라낼 수 없어, 고른
  // 선택지가 골라지지 않은 것처럼 보였다.
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  // 좁은 독 안에서는 계획을 몇 줄씩만 볼 수 있어, 큰 창으로 따로 띄워 읽고 그 자리에서 고른다.
  const [reading, setReading] = useState(false);
  // 아직 고를 수 있는 카드인지. 승인 버튼을 그릴지와 결과 문구를 그릴지가 이 하나로 갈린다.
  const pending = prompt.interactive && !prompt.resolved;
  const decide: ChatApprovalDecider = (id, decision, picked) => {
    setReading(false);
    onDecision(id, decision, picked);
  };
  const actions = pending
    ? <ChatApprovalActions prompt={prompt} plan={plan} questions={questions} picks={picks} onDecide={decide} />
    : null;
  return (
    <article className={`chat-approval${pending ? " chat-approval-pending" : ""}`} role={pending ? "alert" : undefined}>
      <header className="chat-approval-head">
        <strong>{prompt.title}</strong>
        {plan && prompt.detail && (
          <button className="chat-approval-expand" type="button" onClick={() => setReading(true)}>
            <Maximize2 size={13} aria-hidden="true" />크게 보기
          </button>
        )}
      </header>
      <ChatApprovalBody prompt={prompt} plan={plan} questions={questions} picks={picks} onPick={(question, labels) => setPicks((current) => ({ ...current, [question]: labels }))} />
      {prompt.resolved ? (
        <span className="chat-approval-result">{approvalDecisionLabel(prompt.resolved, prompt.kind, Object.keys(prompt.answers).length > 0)}</span>
      ) : actions ? (
        <div>{actions}</div>
      ) : (
        <p>실행 정책에 의해 이미 거절된 권한 기록입니다. 현재 승인을 기다리고 있지 않습니다.</p>
      )}
      {/* 본문이 긴 카드는 어디에 있든(채팅 독·AIA 팝업) 화면 맨 위 레이어에 띄워야 가려지지 않는다. */}
      {reading && createPortal(
        <Modal
          title={prompt.title}
          size="wide"
          elevated
          onClose={() => setReading(false)}
          footer={actions && <div className="chat-approval-modal-actions">{actions}</div>}
        >
          <div className="chat-approval-reader"><MarkdownPreview source={prompt.detail} /></div>
        </Modal>,
        document.body,
      )}
    </article>
  );
}

/**
 * 카드 아래(와 크게 보기 창 바닥)의 응답 버튼 줄. 질문지가 있는 카드는 답을 보내는 두
 * 갈래, 그 밖은 공급자가 제시한 선택지만 그린다.
 */
function ChatApprovalActions({ prompt, plan, questions, picks, onDecide }: {
  prompt: ChatApprovalPrompt;
  plan: boolean;
  questions: ChatApprovalQuestion[];
  picks: Record<string, string[]>;
  onDecide: ChatApprovalDecider;
}) {
  const offered = new Set(prompt.options);
  const answered = questions.filter((question) => (picks[question.question] ?? []).length > 0).length;
  return (
    <>
      {questions.length > 0 ? (
        <>
          <button className="button primary" type="button" disabled={answered === 0} onClick={() => onDecide(prompt.id, "accept", joinedAnswers(picks))}>답변 보내기</button>
          {/* 답을 비운 허용도 유효한 응답이다. 에이전트는 "답하지 않았다"를 받고 스스로 판단해 넘어간다. */}
          <button className="button" type="button" onClick={() => onDecide(prompt.id, "accept")}>답변 없이 진행</button>
        </>
      ) : (
        <>
          {offered.has("accept") && <button className="button primary" type="button" onClick={() => onDecide(prompt.id, "accept")}>{plan ? "계획대로 실행" : "이번만 허용"}</button>}
          {/* 계획 승인의 "세션 동안 허용"은 편집 자동 승인이다. 승인하면 CLI는 계획 모드를
              빠져나가지만 편집 권한은 그대로라 파일마다 다시 묻는데, 이 버튼이 그것을 끈다. */}
          {offered.has("acceptForSession") && <button className="button" type="button" onClick={() => onDecide(prompt.id, "acceptForSession")}>{plan ? "계획대로 실행 + 편집 자동 승인" : "세션 동안 허용"}</button>}
          {offered.has("decline") && <button className="button danger-subtle" type="button" onClick={() => onDecide(prompt.id, "decline")}>{plan ? "계획 다시 세우기" : "거절"}</button>}
        </>
      )}
      {offered.has("cancel") && <button className="button danger-subtle" type="button" onClick={() => onDecide(prompt.id, "cancel")}>작업 취소</button>}
    </>
  );
}

/** 카드 본문. 질문지·계획 문서·요청 원문 세 갈래 중 하나만 그린다. */
function ChatApprovalBody({ prompt, plan, questions, picks, onPick }: {
  prompt: ChatApprovalPrompt;
  plan: boolean;
  questions: ChatApprovalQuestion[];
  picks: Record<string, string[]>;
  onPick: (question: string, labels: string[]) => void;
}) {
  if (questions.length > 0) {
    // 답을 보낸 뒤에는 질문만 남기지 않고 무엇을 골라 보냈는지 그대로 남긴다.
    if (prompt.resolved) return <ChatApprovalAnswerList questions={questions} answers={prompt.answers} />;
    return (
      <section className="chat-approval-questions">
        {questions.map((question) => (
          <ChatApprovalQuestionField
            key={question.question}
            question={question}
            answer={picks[question.question] ?? EMPTY_PICKS}
            onAnswer={(labels) => onPick(question.question, labels)}
          />
        ))}
      </section>
    );
  }
  if (!prompt.detail) return null;
  if (plan) return <section className="chat-approval-document"><MarkdownPreview source={prompt.detail} compact /></section>;
  return <pre>{prompt.detail}</pre>;
}

/** 아직 아무것도 고르지 않은 질문의 답. 매 렌더에 새 배열을 만들지 않도록 하나만 둔다. */
const EMPTY_PICKS: string[] = [];

/** 고른 선택지를 CLI가 읽는 한 줄 답으로 잇는다. 비어 있는 질문은 답하지 않은 것으로 둔다. */
function joinedAnswers(picks: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(picks)
      .filter(([, labels]) => labels.length > 0)
      .map(([question, labels]) => [question, labels.join(", ")]),
  );
}

function ChatApprovalQuestionField({ question, answer, onAnswer }: { question: ChatApprovalQuestion; answer: string[]; onAnswer: (labels: string[]) => void }) {
  const name = useId();
  const [custom, setCustom] = useState("");
  const [customPicked, setCustomPicked] = useState(false);
  // 답 목록에서 선택지 라벨과 직접 입력한 글을 갈라 본다. 라벨을 그대로 맞춰 보므로
  // 콤마가 든 라벨도 고른 그대로 표시된다.
  const optionLabels = answer.filter((label) => question.options.some((option) => option.label === label));
  const picked = new Set(optionLabels);
  const commit = (labels: string[], customText: string, useCustom: boolean) => {
    const parts = [...labels];
    if (useCustom && customText.trim()) parts.push(customText.trim());
    onAnswer(parts);
  };
  const toggle = (label: string) => {
    if (!question.multiSelect) {
      setCustomPicked(false);
      commit([label], custom, false);
      return;
    }
    commit(picked.has(label) ? optionLabels.filter((current) => current !== label) : [...optionLabels, label], custom, customPicked);
  };
  const pickCustom = (text: string) => {
    setCustom(text);
    setCustomPicked(true);
    commit(question.multiSelect ? optionLabels : [], text, true);
  };
  // 여러 개를 고르는 질문에서는 직접 입력도 되돌릴 수 있어야 한다. 라디오는 하나를
  // 고르는 자리라 다시 눌러도 그대로 둔다.
  const toggleCustom = () => {
    if (question.multiSelect && customPicked) {
      setCustomPicked(false);
      commit(optionLabels, custom, false);
      return;
    }
    pickCustom(custom);
  };
  return (
    <div className="chat-approval-question" role="group" aria-labelledby={`${name}-label`}>
      <p id={`${name}-label`}>{question.header && <em>{question.header}</em>}<span>{question.question}</span></p>
      {question.options.map((option) => (
        <label key={option.label}>
          <input
            type={question.multiSelect ? "checkbox" : "radio"}
            name={name}
            checked={picked.has(option.label)}
            onChange={() => toggle(option.label)}
          />
          <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
        </label>
      ))}
      <label className="chat-approval-question-custom">
        <input
          type={question.multiSelect ? "checkbox" : "radio"}
          name={name}
          checked={customPicked}
          onChange={toggleCustom}
        />
        <span>
          <b>직접 입력</b>
          <input type="text" value={custom} placeholder="선택지에 없는 답을 적으세요" onChange={(event) => pickCustom(event.target.value)} />
        </span>
      </label>
    </div>
  );
}

/** 답을 보낸 뒤의 질문 카드. 물어본 질문 옆에 실제로 전달된 답을 남긴다. */
function ChatApprovalAnswerList({ questions, answers }: { questions: ChatApprovalQuestion[]; answers: Record<string, string> }) {
  return (
    <section className="chat-approval-answers">
      {questions.map((question) => (
        <div key={question.question}>
          <p>{question.header && <em>{question.header}</em>}<span>{question.question}</span></p>
          {answers[question.question]
            ? <strong>{answers[question.question]}</strong>
            : <small>답하지 않고 진행했습니다</small>}
        </div>
      ))}
    </section>
  );
}

function approvalDecisionLabel(decision: ChatApprovalDecision, kind: string, answered = false): string {
  const plan = kind === "plan";
  const question = kind === "question";
  if (decision === "accept") return plan ? "계획대로 실행했습니다" : question ? (answered ? "답변을 보냈습니다" : "답변 없이 진행했습니다") : "이번 요청을 허용했습니다";
  if (decision === "acceptForSession") return "이 세션 동안 허용했습니다";
  if (decision === "decline") return plan ? "계획을 다시 세우도록 돌려보냈습니다" : "요청을 거절했습니다";
  return "작업을 취소했습니다";
}

function stableErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("권한") || normalized.includes("forbidden") || normalized.includes("permission")) return "APP_ACCESS_DENIED";
  if (normalized.includes("보안 저장소") || normalized.includes("secure storage")) return "APP_CREDENTIALS";
  if (normalized.includes("찾을 수 없") || normalized.includes("not found")) return "APP_NOT_FOUND";
  if (normalized.includes("시간이 초과") || normalized.includes("timeout")) return "APP_TIMEOUT";
  if (normalized.includes("충돌") || normalized.includes("conflict") || normalized.includes("already") || normalized.includes("계정을 전환할 수 없") || normalized.includes("전환될 때까지 대기")) return "APP_CONFLICT";
  if (normalized.includes("연결") || normalized.includes("websocket") || normalized.includes("network")) return "APP_CONNECTION";
  if (normalized.includes("입력") || normalized.includes("invalid")) return "APP_INVALID_INPUT";
  // 공급자·플랫폼이 그 기능을 제공하지 않아 거절된 요청은 런타임 장애가 아니다.
  if (normalized.includes("지원하지 않") || normalized.includes("unsupported") || normalized.includes("not supported")) return "APP_UNSUPPORTED";
  return "APP_RUNTIME";
}

// 실행설정 바(전송 버튼 위)에서 컨텍스트 사용량을 계정 사용량과 같은 게이지로 보여준다.
// 창 크기를 모르면(공급자가 알려주지 않았거나 압축 직후) 토큰 수만 적는다.
export function ChatContextMeter({ usedTokens, windowTokens }: { usedTokens: number | null; windowTokens: number | null }) {
  if (usedTokens == null) return null;
  const percent = windowTokens ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const level = percent == null ? "" : percent >= 90 ? " critical" : percent >= 75 ? " warning" : "";
  return <div className={`chat-context-meter${level}`} title="마지막 요청 기준 컨텍스트 사용량 추정">
    <em>컨텍스트</em>
    {percent != null && <div className="progress" role="img" aria-label={`컨텍스트 사용량 ${percent}%`}><span style={{ width: `${percent}%` }} /></div>}
    <b>{percent != null ? `${percent}% · ${formatTokenCount(usedTokens)}/${formatTokenCount(windowTokens!)}` : `${formatTokenCount(usedTokens)} 토큰`}</b>
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
  if (items.length === 0) return null;
  return (
    <div className="chat-queue" aria-label="대기 중인 메시지">
      <header>대기열 {items.length}개 · 응답이 끝나면 순서대로 전송됩니다</header>
      {items.map((item, index) => (
        <div className="chat-queue-item" key={item.id}>
          <span className="chat-queue-index">{index + 1}</span>
          <p title={item.text || item.attachments.map((file) => file.name).join(", ")}>{item.text || "첨부 파일"}{item.attachments.length > 0 && <small><Paperclip size={11} /> {item.attachments.map((file) => file.name).join(", ")}</small>}</p>
          <button type="button" title="입력창으로 되돌리기" aria-label="입력창으로 되돌리기" onClick={() => onRecall(item)}><Undo2 size={13} /></button>
          <button type="button" title="대기열에서 삭제" aria-label="대기열에서 삭제" onClick={() => onRemove(item.id)}><X size={13} /></button>
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
        <button type="button" role="menuitem" onClick={() => choose(onQueue)} disabled={sendDisabled}><span><strong>대기열 추가</strong><small>현재 응답이 끝난 뒤 순서대로 전송</small></span><Check size={13} /></button>
        <button type="button" role="menuitem" onClick={() => choose(onDeliver)} disabled={sendDisabled || !canDeliver}><span><strong>작업 중 전달</strong><small>{canDeliver ? "중단하지 않고 지금 하는 작업에 바로 전달" : "이 공급자는 진행 중인 작업에 전달할 수 없습니다"}</small></span></button>
        <button className="danger" type="button" role="menuitem" onClick={() => choose(onInterrupt)}><span><strong>응답 중단</strong><small>지금 응답만 멈추고 쓴 내용은 그대로 둡니다</small></span></button>
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
  if (!hasDraft) {
    return <button className="button danger-subtle chat-stop-action" type="button" onClick={onInterrupt}><Square size={13} />중단</button>;
  }

  return <ChatSendActionMenu
    hasDraft={hasDraft}
    sendDisabled={sendDisabled}
    canDeliver={canDeliver}
    trigger={{
      className: "button primary chat-send-action-trigger",
      content: <>{sending ? "첨부 중…" : "대기열 추가"}<ChevronDown size={13} /></>,
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
export function WorkflowInputControl({ name, field, value, onChange, invalid = false, choices }: {
  name: string;
  field: WorkflowInputField;
  value: string;
  onChange: (value: string) => void;
  /** 실행을 막은 필수 입력. 어느 칸을 채워야 하는지 테두리로 짚어 준다. */
  invalid?: boolean;
  /** 문자열 입력을 자유 입력 대신 저장값이 분명한 selectbox로 제한할 때 쓸 선택지. */
  choices?: { value: string; label: string }[] | null;
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
  if (selectChoices) {
    const placeholder = choices != null
      ? (field.required ? text("선택", "Select") : text("기본 모델", "Default model"))
      : "선택";
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
