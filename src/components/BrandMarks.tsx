/**
 * 표식 모음. 앱 로고(타륜)와 AIA 나침반처럼 손으로 그린 SVG, 그리고 `logos` 팩에서 구워
 * 온 서비스·공급자 표식이 여기 산다. Shared는 화면 뼈대(모달·배너·폼)를 담는 자리라
 * 그림만 따로 두어, 로고 모양을 손볼 때 화면 구조 쪽을 열지 않아도 되게 한다.
 */
import { useEffect, useId, useRef, useState } from "react";
import { SERVICE_ICON_SRC, SERVICE_ICONS_NEEDING_PLATE, type ServiceIconName } from "../assets/serviceIcons";
import type { ProviderId } from "../types";

// 타륜 회전: 스포크가 45° 간격이라 45°의 배수에서 멈춘 그림은 정지 상태와 완전히 같다.
// 감속은 그 배수 자리까지 미끄러지게 해, 애니메이션을 걷어내도 각도가 튀지 않는다.
const WHEEL_SPIN_PERIOD_MS = 1_600;
const WHEEL_SPOKE_COUNT = 8;
// 멈출 자리는 실제로 그려진 스포크 수에서 나온다. 둘을 따로 적어 두면 스포크를 늘렸을 때
// 감속만 옛 간격에 맞춰 멈춰, 정지 그림과 각도가 어긋난다.
const WHEEL_SPOKE_STEP_DEG = 360 / WHEEL_SPOKE_COUNT;
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

/**
 * 중심에서 같은 각도 간격으로 뻗은 선분 한 벌. 타륜의 바깥 스포크·안쪽 스포크와 나침반
 * 베젤의 4방위 틱이 모두 같은 모양인데 좌표를 손으로 적어 두어, 반지름 하나를 손보려면
 * 스무 줄에 흩어진 수를 함께 맞춰야 했다. 파도(`seaWavePath`)와 마찬가지로 값이 아니라
 * 규칙을 적어 둔다.
 *
 * 각도는 12시에서 시작해 시계방향으로 돌고, 좌표는 소수 한 자리까지만 남긴다 — 손으로
 * 적혀 있던 수와 같은 자릿수라 그려지는 그림이 달라지지 않는다.
 */
function radialSpokes(center: number, inner: number, outer: number, count: number): string[] {
  const at = (value: number) => String(Number(value.toFixed(1)));
  return Array.from({ length: count }, (_, index) => {
    const radians = (index * 2 * Math.PI) / count;
    const dx = Math.sin(radians);
    const dy = -Math.cos(radians);
    return `M${at(center + dx * inner)} ${at(center + dy * inner)} L${at(center + dx * outer)} ${at(center + dy * outer)}`;
  });
}

// 그림이 고정이므로 한 번만 만든다.
const WHEEL_OUTER_SPOKES = radialSpokes(512, 218, 322, WHEEL_SPOKE_COUNT);
const WHEEL_INNER_SPOKES = radialSpokes(512, 108, 180, WHEEL_SPOKE_COUNT);
const COMPASS_TICKS = radialSpokes(16, 9.4, 11.9, 4);

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
            {WHEEL_OUTER_SPOKES.map((d) => <path key={d} d={d} />)}
          </g>
          <g strokeWidth="26">
            {WHEEL_INNER_SPOKES.map((d) => <path key={d} d={d} />)}
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
        {COMPASS_TICKS.map((d) => <path key={d} d={d} />)}
      </g>
      <g className="aia-mark-needle" style={{ animationDelay: wander.delay, animationDuration: wander.duration }}>
        <path d="M12.6 9.4 L20.4 16 L12.6 22.6" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-45 16 16) translate(1.8 0)" />
      </g>
    </svg>
  );
}


/**
 * 서비스 표식. `logos` 팩에서 쓰는 이름만 구워 둔 SVG를 그대로 그린다
 * (`npm run icons:generate`). 브랜드 원색을 그대로 쓰므로 악센트 색을 따라가지 않는다 —
 * 상표가 있는 자리와 없는 자리가 구분돼야 하기 때문이다.
 *
 * 데이터 URI를 `<img>`로 그리는 방식이라 `currentColor`가 닿지 않는다. 그래서 색이 없는
 * 단색 글리프는 굽는 목록에 넣지 않고, 검은 글리프로 그려진 표식(GitHub·OpenAI 등)은 흰
 * 받침을 깔아 다크 배경에서도 읽히게 한다 — 받침이 필요한 목록도 함께 구워 온다.
 */
export function BrandMark({ name, size = 16 }: { name: ServiceIconName; size?: number }) {
  const plate = SERVICE_ICONS_NEEDING_PLATE.has(name);
  return <img
    className={`brand-mark ${name}-mark${plate ? " plate" : ""}`}
    src={SERVICE_ICON_SRC[name]}
    width={size}
    height={size}
    alt=""
    aria-hidden="true"
  />;
}

/**
 * 표식을 `size`만 받는 컴포넌트로 감싼다. 탭 목록처럼 그리는 자리가 아니라 컴포넌트 자체를
 * 넘겨야 하는 곳(`SettingsSubTab.icon`)에서 lucide 아이콘과 같은 자리에 놓으려는 것이다.
 * 목록이 모듈 수준이면 컴포넌트도 한 번만 만들어진다.
 */
export function brandMarkIcon(name: ServiceIconName) {
  return ({ size }: { size?: number }) => <BrandMark name={name} size={size} />;
}

/**
 * 공급자의 공식 표식. 안티그래비티는 구글 제품이지만 자기 표식이 따로 있어 그것을 쓴다.
 * 공급자 식별색(클로드 주황·코덱스 녹색·AG 파랑)은 표식이 없는 자리(차트 범례·막대)에
 * 그대로 남는다 — 표식이 설 수 있는 자리만 표식으로 바뀐다.
 */
const PROVIDER_BRANDS: Record<Exclude<ProviderId, "local">, ServiceIconName> = {
  claude: "claude",
  codex: "openai",
  antigravity: "antigravity",
};

/**
 * Ollama 표식의 글리프. `logos` 팩에 없어 구워 올 수 없고, 단색 글리프라 데이터 URI로
 * 구워도 `currentColor`가 닿지 않아 다크 테마에서 검게 사라진다(`BrandMark` 설명). 그래서
 * 굽지 않고 인라인 SVG로 둔다 — 대신 배지의 식별색(보라)이 표식에도 그대로 닿는다.
 *
 * 경로는 simple-icons(CC0)의 `ollama` 글리프이고, 상표 자체는 Ollama의 것이다.
 */
const OLLAMA_GLYPH = "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z";

export function OllamaMark({ size = 16 }: { size?: number }) {
  return <svg
    className="brand-mark ollama-mark"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  ><path d={OLLAMA_GLYPH} /></svg>;
}

export function ProviderMark({ provider, size = 16 }: { provider: ProviderId; size?: number }) {
  // 로컬 공급자는 Ollama 서빙 서버를 전제로 한다(`CliConnectionDrawer`의 안내와 같은 전제).
  // 공식 표식이 있는 자리이므로 성격만 나타내는 아이콘 대신 그 표식을 쓴다.
  if (provider === "local") return <OllamaMark size={size} />;
  return <BrandMark name={PROVIDER_BRANDS[provider]} size={size} />;
}
