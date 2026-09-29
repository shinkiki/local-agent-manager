import { AlertTriangle, BookOpen, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getCommonSkillDetail, getResourceRepository } from "../lib/ipc";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import { workflowDiagram, workflowDiagramPalette } from "../lib/workflowDiagram";
import { useEffectiveDark } from "../lib/useDiagramSvg";
import type { CommonSkillDetail, SystemWorkflowContract } from "../types";
import { DiagramViewer } from "./DiagramViewer";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, ErrorBanner, LoadingState } from "./Shared";

/**
 * 계약 한 벌의 절차를 그림으로 보여 주는 자리. 단계 표가 "무엇을 부르는가"를 세로로 적는다면
 * 여기서는 순서와 데이터 의존, 그리고 계약 바깥의 회차 봉투까지 한눈에 본다.
 *
 * 그림은 계약에서만 만든다(`workflowDiagram`은 순수 함수). 저장소 경로 한 번만 백엔드에
 * 물어보는데, 그것도 스킬 상자에 열 주소를 달기 위한 것이라 실패해도 그림은 그대로 나온다.
 */
export function WorkflowProcedurePanel({ contract, missingSkills }: {
  contract: SystemWorkflowContract;
  missingSkills: string[];
}) {
  const { text, locale } = useI18n();
  // 그림의 색은 지금 화면이 어두운지에 달려 있다. 테마를 바꾸면 원문이 다시 만들어진다.
  const dark = useEffectiveDark();
  const [skillsPath, setSkillsPath] = useState<string | null>(null);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const skills = contract.requiredSkills ?? [];

  useEffect(() => {
    if (skills.length === 0) return;
    let active = true;
    // 경로를 못 읽어도 화면은 멈추지 않는다. 상자에서 클릭만 빠지고 아래 목록은 그대로 연다.
    getResourceRepository()
      .then((settings) => { if (active) setSkillsPath(settings.skillsPath); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [skills.length]);

  const diagram = useMemo(
    () => workflowDiagram(contract, {
      dark,
      skillHref: (skill) => (skillsPath ? `${skillsPath}/${skill}/SKILL.md` : null),
    }),
    // 그림의 라벨도 화면 언어를 따른다. 언어는 원문에 인자로 들어가지 않으므로 여기서
    // 의존으로 적어 두지 않으면 언어를 바꾼 뒤에도 옛 언어의 그림이 그대로 남는다.
    [contract, dark, skillsPath, locale],
  );

  return <section className="workflow-detail-section workflow-procedure">
    <header>
      <span><Waypoints size={15} /></span>
      <div>
        <strong>{text("절차 도식", "Procedure diagram")}</strong>
        <small>{contract.paced
          ? text("계약이 소유한 단계와 스케줄러가 두르는 회차 봉투입니다.", "The contract's own steps plus the round envelope the scheduler wraps around them.")
          : text("계약에 고정된 순서와 단계 사이의 결과 참조입니다.", "The order fixed by the contract and the result references between steps.")}</small>
      </div>
    </header>
    <div className="workflow-diagram" data-ui-anchor="workflows.procedure-diagram">
      <DiagramViewer
        source={diagram}
        fileName={`${contract.id}-procedure`}
        onOpenLocalLink={(href) => setOpenSkill(skillFromHref(href, skills))}
      />
    </div>
    <DiagramLegend dark={dark} paced={contract.paced === true} hasSkills={skills.length > 0} />
    {skills.length > 0 && <div className="workflow-skill-chips">
      <span>{text("필요 스킬", "Required skills")}</span>
      {skills.map((skill) => {
        const absent = missingSkills.includes(skill);
        return <button
          className={`workflow-skill-chip${absent ? " missing" : ""}`}
          type="button"
          key={skill}
          onClick={() => setOpenSkill(skill)}
        >
          {absent ? <AlertTriangle size={12} /> : <BookOpen size={12} />}
          <code>{skill}</code>
        </button>;
      })}
    </div>}
    {missingSkills.length > 0 && <div className="workflow-warning">
      <AlertTriangle size={15} />
      <div>
        <strong>{text("이 장치에 없는 스킬", "Skills this device does not have")}</strong>
        <p>{text(
          `계약은 왔지만 절차가 없습니다. 공통 저장소의 스킬 ${missingSkills.join(", ")}을(를) 먼저 복원해야 실행이 의도대로 돕니다.`,
          `The contract arrived without its procedure. Restore ${missingSkills.join(", ")} into the common repository before running this.`,
        )}</p>
      </div>
    </div>}
    {openSkill && <SkillBodyDrawer skill={openSkill} onClose={() => setOpenSkill(null)} />}
  </section>;
}

/**
 * 상자 색이 무엇을 가르는지. 이 그림의 요점은 "무엇이 계약의 것이고 무엇이 아닌가"인데,
 * 색만으로는 그 경계를 처음 보는 사람이 알 수 없다. 견본 색은 그림을 칠한 것과 같은 표에서
 * 가져오므로 둘이 어긋날 수 없다.
 */
function DiagramLegend({ dark, paced, hasSkills }: { dark: boolean; paced: boolean; hasSkills: boolean }) {
  const { text } = useI18n();
  const palette = workflowDiagramPalette(dark);
  const items = [
    { fill: palette.step, line: palette.stepLine, label: text("계약이 소유한 단계", "Steps the contract owns") },
    paced ? { fill: palette.envelope, line: palette.envelopeLine, label: text("스케줄러의 회차 봉투", "The scheduler's round envelope") } : null,
    hasSkills ? { fill: palette.skill, line: palette.skillLine, label: text("계약이 선언한 스킬", "Skills the contract declares") } : null,
  ].filter((item) => item != null);

  return <ul className="workflow-diagram-legend">
    {items.map((item) => <li key={item.label}>
      <span style={{ background: item.fill, borderColor: item.line }} aria-hidden="true" />
      {item.label}
    </li>)}
  </ul>;
}

/**
 * 그림에서 누른 스킬 상자가 어느 스킬인지. 주소를 쪼개 읽지 않고 **선언된 스킬 중에서만**
 * 고른다 — 그림의 주소는 우리가 넣은 것이지만, 여는 대상을 계약이 선언한 목록으로 좁혀 두면
 * 주소 문자열이 어떻게 바뀌어도 계약 밖의 무언가가 열리지 않는다.
 */
function skillFromHref(href: string, skills: string[]): string | null {
  return skills.find((skill) => href.endsWith(`/${skill}/SKILL.md`)) ?? null;
}

/** 보관 원본 한 벌의 본문. 판정 기준이 보관 원본이므로 설치본이 아니라 원본을 읽는다. */
function SkillBodyDrawer({ skill, onClose }: { skill: string; onClose: () => void }) {
  const { text } = useI18n();
  const [detail, setDetail] = useState<CommonSkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    getCommonSkillDetail(skill)
      .then((value) => { if (active) setDetail(value); })
      .catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [skill]);

  return <Drawer title={<><BookOpen size={15} /><span>{skill}</span></>} onClose={onClose}>
    {error
      ? <ErrorBanner message={error} />
      : detail
        ? <MarkdownPreview source={detail.body} />
        : <LoadingState label={text("스킬 원본을 읽고 있습니다", "Reading the archived skill")} />}
  </Drawer>;
}
