import type { SshEndpointView, SshKeyView } from "../types";
import type { UiText } from "./i18n";

/**
 * SSH 창 둘(직접 접속·공개키 등록)이 같은 전제로 열린다 — 저장된 연결 서버가 있고, 그 서버가
 * 가리키는 키가 ~/.ssh에 남아 있으며 같은 이름의 개인키가 있어야 한다. 두 창이 그 판정과
 * 표시 이름을 따로 계산하고 있었고, 서버 목록의 두 버튼도 같은 조건을 자기 식으로 한 번 더
 * 적어 두어 세 곳이 함께 움직여야 했다. 판정을 여기 한 곳에 두고 못 여는 이유를 그대로 돌려준다.
 *
 * 창은 서버 단위로 열린다. 키 하나를 여러 서버가 함께 쓸 수 있어 지문만으로는 어느 서버인지
 * 정해지지 않기 때문이다. `sshKey`는 서버의 지문으로 키 목록에서 찾은 값이고, 없으면 null이다.
 */
export function sshTerminalTarget(server: SshEndpointView, sshKey: SshKeyView | null, text: UiText = (ko) => ko): { blockedReason: string | null; destination: string } {
  const blockedReason = !sshKey
    ? text("이 서버가 쓰는 키가 ~/.ssh에 없습니다. 서버를 수정해 다른 키를 고르세요.", "The key this server uses is not in ~/.ssh. Edit the server and choose another key.")
    : !sshKey.hasPrivateKey
      ? text("같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다.", "Cannot connect with this key because no private key with the same name exists.")
      : null;
  return {
    blockedReason,
    destination: `${server.user}@${server.host}:${server.port}`,
  };
}

/** 이 서버로 SSH 창을 열 수 있는지. 열 수 없는 서버에는 버튼 자체를 내지 않는다. */
export function canOpenSshTerminal(server: SshEndpointView, sshKey: SshKeyView | null): boolean {
  return sshTerminalTarget(server, sshKey).blockedReason === null;
}
