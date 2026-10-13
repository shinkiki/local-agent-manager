/**
 * 절전 억제 토글을 켤 수 있는지 판정한다.
 *
 * 호스트에 억제 수단이 없는 환경(헤드리스 리눅스 컨테이너에는 `systemd-inhibit`이 없다)에서는
 * 켜도 설정만 저장되고 실제로는 아무것도 걸리지 않는다. 지금까지는 그 호스트에서도 토글이
 * 눌렸고, 사용자는 누른 **뒤에야** "막지 못했습니다" 오류로 그 사실을 알았다. 상태 조회가
 * 이미 `supported: false`로 그 사실을 말해 주므로, 켤 수 없는 호스트에서는 켜는 방향을 막아
 * 실패할 시도 자체를 없앤다(docs/headless-linux-gaps.md L03).
 *
 * 끄는 방향은 막지 않는다. 수단이 있던 기기에서 켜 둔 값이 그대로 남아 있을 수 있고, 그 값을
 * 되돌릴 길까지 막으면 사용자가 끌 수 없는 설정이 생긴다.
 *
 * 상태를 아직 읽지 못했으면 막는다. 설정 화면은 적재 전에 스위치 자체를 내주지 않으므로 지금
 * 이 분기는 그 화면에서 도달하지 않지만, 읽지 못한 값을 바꾸는 요청에 "열림"을 기본값으로 두면
 * 다른 호출자가 생길 때 그 쪽이 조용히 틀린다.
 */
export function sleepToggleDisabled(
  status: { supported: boolean; enabled: boolean } | null,
  options: { loaded: boolean; busy: boolean },
): boolean {
  // C20: 권한은 묻지 않는다(로그인한 채널은 모두 같다). 접속 상태를 아직 못 읽었거나 다른
  // 작업이 도는 동안만 막는다.
  if (!options.loaded || options.busy) return true;
  if (!status) return true;
  return !status.supported && !status.enabled;
}
