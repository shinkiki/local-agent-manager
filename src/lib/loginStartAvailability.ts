/**
 * 시스템 시작 시 자동 시작 행을 이 기동에서 어떻게 그릴지 가른다.
 *
 * 이 값은 백엔드가 아니라 데스크톱 셸(tauri autostart)이 갖고 있다. 그래서 브라우저 화면은
 * 조회도 변경도 하지 못하고, 지금까지는 그 사정을 "호스트의 Agent Manager 데스크톱 앱에서만
 * 바꿀 수 있습니다"로 한 가지로만 말했다. 헤드리스(NAS 컨테이너) 기동에는 그 호스트 앱이
 * 아예 없어서, 그 문구는 존재하지 않는 화면으로 사용자를 보낸다
 * (docs/headless-linux-gaps.md L08).
 *
 * 헤드리스를 먼저 본다. 데스크톱 셸이 없다는 사실은 "지금 보는 화면이 브라우저다"보다 강한
 * 조건이라, 두 사정이 겹치면 가리킬 데가 없다는 쪽을 말해야 한다.
 */
export type LoginStartAvailability = "manageable" | "desktopOnly" | "notApplicable";

export function loginStartAvailability(
  options: { nativeRuntime: boolean; headless: boolean },
): LoginStartAvailability {
  if (options.headless) return "notApplicable";
  if (!options.nativeRuntime) return "desktopOnly";
  return "manageable";
}
