/**
 * 워크플로 흐름도의 색 — 테마별 상자 색표와, 그 표를 mermaid 색 선언 줄로 옮기는 일.
 *
 * 그림을 조립하는 쪽(`workflowDiagram`)과는 서로 읽을 것이 없다. 저쪽은 계약이 보장하는
 * 것을 상자와 화살표로 옮기는 일이라 계약의 모양이 바뀔 때 달라지고, 여기는 앱 화면이
 * 어떤 배경 위에서 어떤 계열로 읽히는지 하나만 보므로 화면 색이 바뀔 때 달라진다. 한
 * 파일에 두면 상자 색 한 칸을 고치러 들어온 사람이 단계 순서선과 라벨 이스케이프 규칙을,
 * 반대로 계약 단계를 하나 늘리러 온 사람은 이 두 벌의 색표를 지나쳐야 한다.
 *
 * 그래서 색 선언 줄을 만드는 일까지 여기가 가진다 — 조립하는 쪽이 hex를 한 번도 이름
 * 부르지 않아야 색표가 정말 이 모듈 하나에만 있다.
 */

/** 색을 지정할 수 있는 자리. 표의 `X`·`XLine`·`XText` 세 칸이 한 역할을 이룬다. */
type PaletteRole = "entry" | "step" | "envelope" | "skill" | "cluster";

/**
 * 역할 하나의 상자·테두리·글자 색을 mermaid 스타일 문자열로 옮긴다.
 *
 * 자리마다 이 세 칸을 손으로 늘어놓고 있었다. 여섯 줄이 같은 모양이라 한 줄에서 `color`를
 * 빠뜨리거나 다른 역할의 칸을 집어도 문법은 멀쩡해, 그림이 그려진 뒤 색으로만 드러난다.
 * 역할 이름 하나로 세 칸을 함께 집으면 그 어긋남이 타입에서 걸린다.
 */
function diagramTone(palette: WorkflowDiagramPalette, role: PaletteRole): string {
  return `fill:${palette[role]},stroke:${palette[`${role}Line`]},color:${palette[`${role}Text`]}`;
}

/**
 * 그림의 색. 계약이 소유한 단계는 엔진 기본 상자 그대로 두고, **계약 밖의 것만** 칠한다 —
 * 봉투(브라스)와 스킬(청록)이 기본 상자와 달라야 "이건 계약이 하는 일이 아니다"가 색으로
 * 읽힌다. 묶음 상자도 함께 칠하는데, 엔진 기본 묶음색(회색)은 앱의 네이비 화면에서 혼자
 * 다른 계열로 뜬다.
 */
export function workflowDiagramPaletteLines(dark: boolean, paced: boolean): string[] {
  const palette = workflowDiagramPalette(dark);
  const paint = (role: PaletteRole) => diagramTone(palette, role);
  const lines = [
    `  classDef entry ${paint("entry")}`,
    `  classDef step ${paint("step")}`,
    `  classDef envelope ${paint("envelope")}`,
    // 봉투 안의 기동 상자만 점선 테두리다. 색은 봉투와 같아야 같은 구역으로 읽힌다.
    `  classDef envelopeGate ${paint("envelope")},stroke-dasharray:4 3`,
    `  classDef skill ${paint("skill")}`,
    `  style wf_contract ${paint("cluster")}`,
  ];
  // 봉투 묶음은 페이싱 계약에만 있다. 없는 id에 style을 걸면 엔진이 그림을 통째로 버린다.
  if (paced) lines.push(`  style wf_envelope ${paint("cluster")}`);
  return lines;
}

/**
 * 그림에 쓴 색을 화면도 읽는다. 범례의 견본이 그림과 다른 색이면 범례가 거짓말을 하므로,
 * 두 곳이 같은 표를 본다.
 */
export function workflowDiagramPalette(dark: boolean): WorkflowDiagramPalette {
  return dark ? DARK_PALETTE : LIGHT_PALETTE;
}

export type WorkflowDiagramPalette = typeof DARK_PALETTE;

/** 어두운 테마의 상자 색. 앱의 네이비 화면(`--x080e14` 위)에서 읽히는 값들이다. */
const DARK_PALETTE = {
  entry: "#101a24",
  entryLine: "#2b3b4c",
  entryText: "#9fb0c2",
  step: "#16202b",
  stepLine: "#35495e",
  stepText: "#d3dde8",
  envelope: "#241d12",
  envelopeLine: "#8a6b36",
  envelopeText: "#e8cf9d",
  skill: "#10222c",
  skillLine: "#41708a",
  skillText: "#bcd9e8",
  cluster: "#0c141d",
  clusterLine: "#26364a",
  clusterText: "#93a5ba",
};

/** 밝은 테마의 같은 자리. 종이 위의 브라스·청록으로 같은 구분을 유지한다. */
const LIGHT_PALETTE = {
  entry: "#eef1f5",
  entryLine: "#c6d0da",
  entryText: "#43536a",
  step: "#ffffff",
  stepLine: "#b9c6d3",
  stepText: "#20303f",
  envelope: "#f4f1ea",
  envelopeLine: "#b08d57",
  envelopeText: "#4a3b22",
  skill: "#eef4f7",
  skillLine: "#4a7a94",
  skillText: "#20394a",
  cluster: "#f7f9fc",
  clusterLine: "#ccd6e2",
  clusterText: "#4a5a6c",
};
