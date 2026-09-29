/**
 * "읽을 것이 아직 없다"를 AIA에게 넘기는 요청문.
 *
 * 온보딩은 마일스톤·기록 문서가 **이미 있다**고 보고 그 위치만 묻는다. 처음 여는
 * 프로젝트에는 그것이 없어서, 사용자가 카드를 여기까지 채워 놓고 빈손으로 나가
 * 문서를 손으로 만든 뒤 돌아와야 했다. 그 자리에서 AIA에게 넘길 수 있게, 카드가 이미
 * 받아 둔 값(목표·완료 기준·마감·위치)을 그대로 실은 요청문 한 벌을 만든다.
 *
 * 만드는 일은 AIA가 한다 — 앱은 파일을 쓰지 않는다. 그래서 요청문에는 무엇을 근거로,
 * 어디에, 어떤 모양으로 남길지가 다 들어가야 한다. 온보딩 카드가 그 산출물을 그대로
 * 읽어야 하므로 위치와 파일 구성은 사용자가 고른 값을 그대로 적는다.
 */
import type { AiaOnboardingCard, AiaOnboardingField } from "../types";
import { cardSteps, visibleFields } from "./aiaOnboardingCard.ts";
import type { OnboardingValues } from "./aiaOnboardingValues.ts";
import { localized } from "./aiaOnboarding.ts";

type TextFn = (ko: string, en: string) => string;

/** 지금 화면에 서 있고 값이 든 칸만 "이름: 값" 줄로. AIA가 근거로 읽을 것들이다. */
function filledLines(card: AiaOnboardingCard, values: OnboardingValues, text: TextFn): string[] {
  return cardSteps(card)
    .flatMap((step) => visibleFields(step, values))
    .flatMap((field) => {
      const value = (values[field.key] ?? "").trim();
      return value.length > 0 ? [`- ${localized(field.label, text)}: ${value}`] : [];
    });
}

/**
 * 고른 기록 대상 한 칸을 두고 AIA에게 "이 자리에 읽을 것을 만들어 달라"고 하는 요청문.
 *
 * 대상을 아직 고르지 않았으면 고르라고 되돌리지 않는다 — 그때는 어디가 좋을지까지
 * AIA가 정하게 한다. 프로젝트를 아직 고르지 않은 채 눌렀다면 요청문에 경로가 비고,
 * AIA가 어디에 둘지 먼저 묻게 된다.
 */
export function onboardingDraftPrompt(
  card: AiaOnboardingCard,
  field: AiaOnboardingField,
  values: OnboardingValues,
  text: TextFn,
): string {
  const cardTitle = localized(card.title, text);
  const fieldLabel = localized(field.label, text);
  const target = (values[field.key] ?? "").trim();
  const lines = filledLines(card, values, text);
  const known = lines.length > 0
    ? lines.join("\n")
    : text("- (아직 적은 값이 없습니다)", "- (nothing filled in yet)");
  const targetLine = target.length > 0
    ? text(`고른 위치는 '${target}'이다. 그 자리에 남긴다.`, `The chosen location is '${target}'. Put them there.`)
    : text(
      "위치를 아직 고르지 않았다. 프로젝트 안의 마크다운이 좋은지, 붙어 있는 플러그인(노션·지라)이 좋은지 먼저 정해 제안하고 만든다.",
      "No location has been chosen yet. Decide whether Markdown inside the project or a connected plugin (Notion, Jira) fits better, say which, then create them there.",
    );

  return text(
    [
      `애드온 → 자동화의 '${cardTitle}' 온보딩을 채우는 중인데 '${fieldLabel}'에서 읽을 것이 아직 없다. 지금 있는 값을 근거로 만들어 달라.`,
      "",
      "지금까지 적은 값:",
      known,
      "",
      "해 줄 일:",
      `1. 위 값과 프로젝트를 직접 살펴 목표를 회차로 나눌 수 있는 단위로 쪼갠다. 근거 없이 지어내지 말고, 모르는 것은 나에게 묻는다.`,
      `2. ${targetLine}`,
      "3. 항목마다 상태(예정·진행·완료)·완료 조건·기한을 적어, 온보딩 회차가 한 항목씩 집어 진행하고 그 자리에 상태를 되쓸 수 있게 한다.",
      "4. 파일·페이지를 만들기 전에 무엇을 어디에 만들지 먼저 보여 주고 승인을 받는다.",
      "5. 다 만들었으면 만들어진 위치를 한 줄로 알려 준다. 나는 그 값을 온보딩 카드에 적고 이어서 만들기를 누른다.",
    ].join("\n"),
    [
      `I'm filling in the '${cardTitle}' onboarding under Add-ons → Automation, and there is nothing yet for '${fieldLabel}'. Create it from what I've entered so far.`,
      "",
      "What I've entered:",
      known,
      "",
      "What to do:",
      "1. Read the values above and look at the project itself, then split the goal into units a single round can take on. Don't invent anything — ask me where you're unsure.",
      `2. ${targetLine}`,
      "3. Give every item a status (planned, in progress, done), exit criteria, and a due date, so an onboarding round can take one item and write its status back in place.",
      "4. Before creating files or pages, show me what goes where and get my approval.",
      "5. When it's done, tell me the location in one line. I'll put that into the onboarding card and continue.",
    ].join("\n"),
  );
}
