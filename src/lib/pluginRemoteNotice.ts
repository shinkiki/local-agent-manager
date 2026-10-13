/**
 * 외부 플러그인 카드가 호스트 화면이 아닌 접속 위에 띄우는 안내 띠의 종류를 가른다.
 *
 * 묻는 것은 "원격이냐"가 아니라 **호스트 화면이냐**다. 헤드리스(NAS 컨테이너) 백엔드는 SSH
 * 터널이나 loopback으로도 열리고 그때 접속 정보의 `remote`는 거짓이 되지만, 승인 창을 띄울
 * 데스크톱이 없다는 사실은 그대로다(docs/headless-linux-gaps.md H04). 부르는 쪽이 그
 * 판정(`hostScreen`)을 이미 갖고 있으므로 여기서는 받기만 한다.
 *
 * 호스트 화면이 아니어도 막히는 인증 방식은 없다. 기기 코드 흐름은 loopback을 쓰지 않고(H03),
 * 콜백형 OAuth는 승인 뒤 브라우저가 멈춘 콜백 주소를 붙여 넣어 끝낸다(2026-10-11). 안내 띠는
 * 그 붙여넣기 단계를 미리 알리는 자리다 — 처음 보는 사용자에게 "연결할 수 없음" 화면은
 * 실패로 읽히기 때문이다.
 */
export type PluginRemoteNotice = "none" | "paste";

export function pluginRemoteNotice(options: { hostScreen: boolean }): PluginRemoteNotice {
  return options.hostScreen ? "none" : "paste";
}
