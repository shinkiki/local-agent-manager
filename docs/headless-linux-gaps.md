# 헤드리스 리눅스(NAS) 배포에서 제한되는 기능 — 회차 백로그

`deploy/synology/`의 헤드리스 서버를 2026-10-10 시놀로지 NAS(DSM 7.3.2, x86_64, 커널 4.4)에 실제로
올려 확인한 제한과, 코드에서 찾은 플랫폼·호스트 전용 분기를 한곳에 모은 목록이다.
`headless-linux-gap-round` 회차가 이 표에서 **상태가 `대기`인 항목 1건**을 골라 처리하고, 같은 커밋에서
상태 칸만 고친다. 표의 다른 칸은 사람이 고친다.

헤드리스에서는 접속자가 언제나 "원격"이다. 2026-10-11 C20(접근 채널 로그인)으로 호스트 전용
목록(`is_host_only_command`)과 원격 편집 토글이 사라졌다 — 로그인한 뒤에는 원격도 데스크톱과 같은
권한이다. 마지막으로 남았던 원격 거절(콜백형 외부 플러그인 OAuth 시작)도 같은 날 H13으로 풀렸다.
그래서 D1에 매달려 있던 H 계열은 그 결정 없이 풀렸다.

**H01·H02·H05·H06 넷 다 `보류`이며 사람이 1회 실측해야 끝난다(H02는 2026-10-11, 나머지 셋은 G01 2026-10-12).**
D1=(c) 결정에 따라 넷은 2026-10-11에 `대기`로 올라왔지만(아래 D1 행의 "대기로 올린다"가 그것이다),
실측이 사람에게만 가능해 무인 회차가 끝낼 수 없다는 것이 드러나 H02가 먼저 `f83015ed`에서,
H01·H05·H06이 2026-10-12에 `보류`로 내려갔다. 근거는 되돌아 나온 회차 기록이다 — H01은 `a53c94e3`에
그 사실이 적혔고, 2026-10-12 00:15~00:25 사이 세 회차(G01·G02·G05)가 연달아 기동해 남은 셋 말고는
고를 것이 없어 아무것도 착지시키지 못하고 끝났다. 사람이 실측해 `완료(사람 YYYY-MM-DD)`로 적으면
끝나고, 다시 무인 대상으로 돌리고 싶으면 상태를 `대기`로 되돌리는 것도 사람의 몫이다. 넷 다 "NAS 원격
화면에 로그인한 뒤"가 전제인데, 그 원격 채널은 비밀번호를 요구하고(`/api/access` →
`loginRequired.password: true`) 무인 회차는 비밀번호를 가질 수 없다 — 비밀값 입력 카드는 사람이
답해야 하고, 무인 실행에서는 답이 오지 않는다. 회차가 확인할 수 있는 절반은 측정해 두었다:
tailnet HTTPS(`TAILSCALE_HOST`, protocolVersion 12, `channel: remote`,
`headless: true`)에서 옛 호스트 전용 명령 네 가지(`set_external_plugin_tool_policy`·
`execute_ssh_command`·`push_project_git`·`run_db_statement`)와 옛 원격 거절
(`begin_external_plugin_oauth`), 그리고 평범한 읽기(`get_app_status`)가 **모두 똑같이**
`401 LOGIN_REQUIRED`로 끝났다. 명령별로 갈라지는 거절은 하나도 남지 않았고, 소스에도
`is_host_only_command`·`is_remote_refused_command`는 없다. 남은 것은 로그인한 뒤 실제로 열리는지
한 번 눌러 보는 일뿐이므로, 사람이 그 한 번을 하고 네 행의 상태를 `완료(사람 YYYY-MM-DD)`로 적는다.

**재배포** 전제는 없어졌다(G01 2026-10-12, 읽기 명령과 조회로만 관측 — 이 회차는 재생성·기동을
하지 않았다). 운영 NAS의 `agent-manager` 컨테이너가 `agent-manager-server:local`로 이미 재생성돼
있고(`docker ps` 기준 2026-10-12 00:15 KST), tailnet HTTPS(`TAILSCALE_HOST`)의 `/api/access`가
`protocolVersion 12`, `channel: remote`, `headless: true`,
`loginRequired: {password: true, otp: false}`를 돌려준다 — `writable` 칸은 없다. 즉 C20이 들어간
이미지가 떠 있으므로 **재배포 없이 바로 로그인해서 눌러 보면 된다.** 남은 전제는 사람의 로그인 1회뿐이고,
그때까지 이 백로그에는 `대기` 항목이 하나도 없어 무인 회차는 후보 없음으로 즉시 끝난다.

## 상태 값

`대기` · `진행(<레인>)` · `완료(<레인> YYYY-MM-DD)` · `결정대기(D<n>)` · `보류` · `해당없음`

## 사람이 정할 것 (회차는 손대지 않는다)

| ID | 결정 | 선택지 | 권고 |
| --- | --- | --- | --- |
| D1 | 헤드리스 운영자 모드 | (a) `--headless-host` 기동 인자 + `TAILSCALE_USER` 일치 판정 (b) 호스트 전용 유지 (c) 로그인 게이트(C20)에 얹어 로그인한 채널을 호스트로 본다 | **(c)로 결정(사용자 2026-10-11).** tailnet 계정 일치 판정은 만들지 않는다. C20이 착지하면 H01·H02·H05·H06·H09를 "로그인한 채널" 전제로 수용 기준을 다시 쓰고 `대기`로 올린다. 그전까지는 결정대기 유지 |
| D2 | 컨테이너 볼트 보호 수준 | (a) gnome-keyring + `KEYRING_PASSWORD` 유지 (b) 앱 자체 파일 암호화 볼트 (c) 외부 비밀 저장소 | **(a)로 결정(사용자 2026-10-11).** 외부 토큰(PAT 등)은 저장소 범위·만료를 좁혀 받는다 |
| D3 | 이미지에 Codex·Antigravity CLI 포함 | (a) `@openai/codex`와 `agy`(Antigravity CLI) 추가 (b) Claude만 | **(a)로 결정(사용자 2026-10-10)** |
| D4 | `deploy/synology/README.md`의 "미검증" 절 갱신 | 사용자 문서이므로 회차가 쓰지 않는다 | **사용자 승인(2026-10-11)으로 사람이 갱신함.** 이후에도 회차는 README를 고치지 않고 보고에만 남긴다 |

## 백로그

우선순위: P1 = 헤드리스에서 쓸 수 없는 핵심 기능, P2 = 쓸 수 있으나 안내·동작이 어긋남, P3 = 확인만 필요.
종류: `개선` = 코드 변경, `검증` = NAS에서 실측해 결과를 보고(코드 변경은 결과에 따라), `문서화` = 안내문·힌트 수정.

| ID | P | 종류 | 영역 | 증상 | 근거 | 수용 기준 | 상태 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H01 | P1 | 검증 | 원격 판정 | 헤드리스에서는 호스트 전용 명령 17개가 영구히 거부됐다 | `remote.rs` `is_host_only_command`(C20에서 제거), `authorize()` | **C20으로 해결(사용자 결정 D1=c).** 호스트 전용 목록이 사라지고 로그인한 채널이 데스크톱과 같다. NAS 원격 화면에서 로그인한 뒤 옛 호스트 전용 명령(플러그인 정책·SSH·DB·git push)이 모두 열리는지 실측해 완료로 바꾼다 | 보류 |
| H02 | P1 | 검증 | 외부 플러그인 | 도구별 허용·확인·제한 정책을 원격에서 편집할 수 없었다 | C20 이전 host-only `set_external_plugin_tool_policy(_policies)` | NAS 원격(로그인한 채널)에서 GitHub 플러그인의 도구 정책을 바꾸고 저장되는지 실측 | 보류 |
| H03 | P2 | 개선 | 외부 플러그인 | OAuth 시작이 호스트 전용이다. 콜백이 loopback으로 오는 흐름은 맞지만, GitHub처럼 기기 코드 흐름인 프리셋은 원격에서도 끝낼 수 있다 | `remote.rs` `begin_external_plugin_oauth`, `external_plugins.rs:188` `PluginAuthKind::OAuthDevice` | 기기 코드 인증(`OAuthDevice`)은 원격 쓰기 모드에서 시작·완료할 수 있고, 콜백형 OAuth만 호스트 전용으로 남는다 | 완료(G02 2026-10-11) |
| H04 | P2 | 문서화 | 외부 플러그인 | 원격 안내문이 "호스트 앱에서 끝내세요"라고 하는데 헤드리스에는 호스트 앱이 없다 | `src/components/ExternalPluginsCard.tsx:487-491` | 접속 정보에 헤드리스 표시가 있으면(서버가 `--tailscale-host`로 떴고 데스크톱 소유자가 없음) 안내문이 "토큰 방식으로 등록" 한 가지만 말한다 | 완료(G03 2026-10-11) |
| H13 | P1 | 개선 | 외부 플러그인 | 콜백형 OAuth(Notion 호스팅·Jira·Google 4종)는 승인 결과가 백엔드 loopback으로 돌아와 원격·헤드리스 화면에서는 시작조차 거절됐다 | `external_plugins.rs` `begin_oauth`, `wait_for_callback` | 원격에서도 시작되고, 승인 뒤 브라우저가 멈춘 `127.0.0.1:<포트>/callback?code=…&state=…` 주소를 승인 모달에 붙여 넣으면 같은 대기 스레드가 code를 교환한다. redirect 주소·state 대조를 단위 테스트가 고정한다 | 완료(사람 2026-10-11) |
| H05 | P1 | 검증 | SSH 애드온 | 원격 화면에서 SSH 명령 실행·릴레이·영구 허용·파일 전송이 전부 막혔다 | C20 이전 host-only `execute_ssh_command` 등 | NAS 원격(로그인한 채널)에서 연결 서버에 `uname -a` 실행과 키 생성(L19 openssh-client)이 되는지 실측 | 보류 |
| H06 | P1 | 검증 | DB 애드온 | 원격 화면에서 DB 연결 등록·삭제·실행이 막혔다(C10-5) | C10-14: C20부터 로그인한 채널에 열림 | NAS 원격(로그인한 채널)에서 DB 연결 등록(비밀번호 입력)과 조회 1건이 되는지 실측 | 보류 |
| H07 | P1 | 개선 | 프로젝트 git | 원격 쓰기 모드에서도 `push`만 호스트 전용이라 NAS에서 코드를 올릴 수 없다 | `remote.rs` host-only `push_project_git`, `ProjectGitPanel.tsx:85` | 원격 쓰기 모드에서 push가 열리되 C16-3 비대화형 규칙은 그대로이고, 자격증명 없음은 `authFailed` 영수증으로 끝난다 | 완료(G03 2026-10-10) |
| H08 | P1 | 개선 | git 자격증명 | 컨테이너에 credential helper도 SSH 키도 없어 HTTPS·SSH 원격 모두 인증 실패한다 | `AGENTS.md` C16-3(빈 `GIT_ASKPASS`), 이미지에 helper 없음 | **축소안(사용자 2026-10-11):** SSH 애드온 키에 "git 원격용" 표시를 두고 **프로젝트 git(화면·API의 fetch·pull·push)에만** `GIT_SSH_COMMAND`로 주입한다. 에이전트 자식 프로세스에는 넣지 않는다(C9·C16-2 경계 유지). 키는 파일에 복사되지 않고 경로만 넘기며, 원격 응답에서 경로는 가린다 | 완료(G01 2026-10-11) |
| H09 | P2 | 개선 | 백엔드 설정 | 원격 편집 토글이 호스트 전용이라 헤드리스에서는 `.env`를 고치고 재기동해야만 바뀌었다 | C20이 `remoteWrite` 토글 자체를 없앰 | 토글이 사라져 해당 없음. 원격 권한은 채널 로그인(C20)이 결정한다 | 해당없음 |
| H10 | P2 | 문서화 | 백엔드 설정 | Tailscale 서비스 켜기·끄기 UI가 "앱을 재시작합니다" 흐름인데 헤드리스는 사이드카가 담당해 해당 없다 | `SettingsView.tsx:3300-3312` | 헤드리스 표시가 있으면 Tailscale 서비스 카드를 "사이드카가 담당" 읽기 전용 안내로 바꾼다 | 완료(G03 2026-10-10) |
| H11 | P2 | 개선 | CLI 연결 | 컨테이너 CLI가 root 소유 이미지 레이어(`/usr/local`)에 고정돼 앱의 업데이트 버튼이 막혀 있었다. 예전 수용 기준("이미지 재빌드로 갱신" 안내, G05 2026-10-10 완료)을 2026-10-16 사람 결정으로 뒤집었다 | `deploy/synology/Dockerfile` 씨앗 prefix, `entrypoint.sh` 씨앗 심기, `cli_updates.rs` `read_only_install_reason`, `src/lib/cliUpdate.ts` | 이미지는 CLI를 씨앗(`/opt/agent-manager/cli-seed`)으로만 담고 엔트리포인트가 HOME 볼륨 `~/.local`에 없는 것만 심는다. 헤드리스에서도 업데이트 버튼이 켜져 Claude·Codex는 `npm install -g`(prefix `~/.local`), `agy`는 `agy update`로 올라가고 `down`/`up -d` 뒤에도 유지된다. `AGENT_MANAGER_RESEED_CLI=1`이면 씨앗으로 되돌린다. 쓸 수 없는 설치본(옛 이미지)은 백엔드가 재생성 사유로 버튼을 끈다. 씨앗 갈래는 `deploy/synology/test-cli-seed.sh`가 고정한다 | 보류(NAS 재배포 실측 대기 — 아래 재배포 실측 목록 H11) |
| H12 | P3 | 검증 | 자원 저장소 | 자원 저장소 경로 변경이 호스트 전용이다. 컨테이너 `/data` 고정이면 문제없는지 확인 | `remote.rs` host-only `set_resource_repository`, `resource_repository.rs:57` Linux 분기 | NAS에서 스킬 게시·동기화가 `/data` 경로로 동작하는 것을 실측 보고 | 완료(G05 2026-10-10) |
| L01 | P1 | 검증 | 계정 로그인 | Claude 로그인(코드 붙여넣기)·Codex(기기 코드)가 컨테이너 pty + 키링 조합에서 끝나는지 미검증 | `accounts.rs:1758` `begin_login`, `TerminalPanel.tsx:179-205`, `deploy/synology/README.md` 미검증 절 | NAS 원격 화면에서 Claude 계정 추가가 "로그인 완료 저장"까지 가고 채팅 1턴이 돈다. 결과(성공·실패 지점)를 보고에 남긴다 | 완료(사람 2026-10-10: 원격 로그인·저장 성공, 채팅은 L13 때문에 실패했다가 IS_SANDBOX=1로 통과) |
| L02 | P2 | 검증 | 자격증명 볼트 | Secret Service 백엔드에 항목 한도가 없고(`None`) 암호 env로 자동 해제된다. 재기동·암호 변경 시 동작 미확인 | `os_keychain.rs:645`, `entrypoint.sh` | 재기동 후 기존 계정이 그대로 보이고, 암호를 바꾸면 명확한 오류로 끝난다(조용히 빈 목록이 아니다) | 완료(G02 2026-10-11) |
| L03 | P3 | 검증 | 절전 방지 | 리눅스는 `systemd-inhibit`을 부르는데 컨테이너에는 systemd가 없다 | `power.rs:244-262` | 실행 파일 없음이 오류 로그·화면 경고 없이 조용한 무동작으로 끝나는지 확인하고, 아니면 헤드리스에서는 기능을 숨긴다 | 완료(G02 2026-10-10) |
| L04 | P2 | 개선 | 터미널 | 리눅스 셸이 `/bin/sh -l`이고 컨테이너에 로케일 패키지가 없어 한글 출력이 깨질 수 있다 | `terminal.rs:1222`, `deploy/synology/Dockerfile` | 이미지에 `LANG=C.UTF-8`이 설정되고 터미널·CLI 출력의 한글이 깨지지 않는다 | 완료(G03 2026-10-10) |
| L05 | P3 | 검증 | 외부 프로세스 | 프로세스 목록이 `ps -axo pid=,ppid=,uid=,args=`를 부른다. procps에서 동작하는지, PID 1(init) 하위 회수가 맞는지 | `external_processes.rs:119`, `docker-compose.yml` `init: true` | 채팅 강제 종료 뒤 좀비가 남지 않고 외부 프로세스 목록이 비어 있지 않다 | 완료(G05 2026-10-10) |
| L06 | P3 | 검증 | 관리 설정 | Claude 관리 정책 파일 경로가 리눅스에서 `/etc/claude-code/managed-settings.json`이다. 컨테이너에 없을 때 동작 확인 | `claude_settings.rs:888-906` | 파일 없음이 오류가 아니라 "정책 없음"으로 읽힌다 | 완료(G05 2026-10-10) |
| L07 | P2 | 검증 | 알림 | OS 알림은 데스크톱 전용이다. 원격 브라우저·PWA 알림이 tailnet HTTPS에서 뜨는지 | `src-tauri/src/lib.rs:138`, `src/lib/webNotificationContent.ts` | 승인 요청·완료 알림이 원격 브라우저에 도착한다. 안 되면 원인을 보고 | 완료(G03 2026-10-10) |
| L08 | P3 | 문서화 | 설정 화면 | 로그인 시 자동 실행 같은 데스크톱 전용 항목이 헤드리스 화면에 그대로 보인다 | `SettingsView.tsx` 런타임 설정 | 헤드리스 표시가 있으면 데스크톱 전용 항목을 숨기거나 "해당 없음"으로 표시한다 | 완료(G02 2026-10-10) |
| L09 | P3 | 문서화 | 세션·저장 공간 | 세션 탐색기와 저장 공간이 컨테이너 안 `/root/.claude` 등만 본다. 사용자 맥의 세션은 보이지 않는다 | `accounts.rs` 공급자 홈 로그 | 저장 공간 화면이 컨테이너 경로임을 표시한다 | 완료(G03 2026-10-10) |
| L10 | P3 | 검증 | 사이드카 | 커널 4.4에서 Tailscale 사이드카가 iptables connmark 경고를 낸다. 접속은 된다 | 2026-10-10 NAS 로그 | `TS_USERSPACE=true`로 재배포해 실측: tailnet 가입·serve·`/api/access`·브라우저 접속 모두 정상(2026-10-11 23:00). NAS `.env`는 `true`로 두었고 compose 기본값 변경은 L21로 분리 | 완료(사람 2026-10-11) |
| L11 | P1 | 개선 | 이미지 | Codex CLI와 Antigravity CLI(`agy`)가 없어 두 공급자의 계정 추가가 시작부터 막힌다. 이미지 주석은 Antigravity를 IDE 런처로 잘못 적고 있었다(`agy`는 linux_amd64 네이티브 CLI) | `deploy/synology/Dockerfile`, `providers.rs:47` 실행 파일 이름 `agy`, 2026-10-10 NAS 실측 | 이미지에 `@openai/codex`와 `agy`가 `/usr/local/bin`에 들어가고, 재배포 뒤 원격 화면에서 Codex(기기 코드)·Antigravity(구글 동의 + 코드 붙여넣기) 계정 추가가 끝난다 | 완료(사람 2026-10-10) |
| L12 | P2 | 개선 | AIA | 시스템 인터페이스 한계 문구가 "설정 → CLI 연결·계정 화면"을 가리키는데 헤드리스에서는 그 화면의 터미널이 호스트 전용이다 | `system_mcp.rs:47` `INTERFACE_LIMITS`, `terminal.ts:45` | 계정 로그인 터미널(`accountLogin`)은 원격에서 열리므로 안내가 그 경로를 가리키고, 설정 터미널만 호스트 전용으로 말한다 | 완료(G02 2026-10-10) |
| L13 | P1 | 개선 | 이미지·실행 사용자 | 컨테이너가 root로 돌아 Claude CLI가 `--dangerously-skip-permissions`를 거부하고 전체 접근 채팅이 exit 1로 끝난다. 지금은 compose의 `IS_SANDBOX=1`로 검사를 우회 중(값은 `1`만 인정) | `chat.rs:11391`, 2026-10-10 NAS 실측, `deploy/synology/docker-compose.yml` | 이미지가 전용 사용자(`agent`, HOME은 `/root` 대신 볼륨 경로)로 서버·키링·CLI를 띄우고, 엔트리포인트가 root로 볼륨 소유권만 맞춘 뒤 `setpriv`로 권한을 내린다. `IS_SANDBOX` 없이 전체 접근 채팅 1턴이 돈다 | 완료(G02 2026-10-10) |
| L14 | P1 | 개선 | 데이터 보존 | 볼트(`~/.local/share/keyrings`)와 공급자 홈(`~/.claude`·`~/.codex`)이 `/data` 밖 HOME에 있어 컨테이너 재생성 시 계정·세션이 사라졌다 | 2026-10-10 NAS 실측 | compose가 HOME 전체를 `./data/home`에 바인드 마운트한다(적용됨). L13에서 사용자를 바꿀 때 마운트 대상만 옮긴다 | 완료(사람 2026-10-10) |
| L15 | P1 | 개선 | 계정 로그인 | 원격 탭이 로그인 CLI의 종료 이벤트를 놓치면(소켓이 잠깐 끊긴 뒤 2분 유예 경과) 자격증명이 이미 떨어졌어도 "로그인 완료 저장"이 켜지지 않았다 | 2026-10-10 NAS 실측(Codex 기기 코드 승인 성공, auth.json 생성, 버튼 꺼짐), `TerminalPanel.tsx` 종료 이벤트 기반 판정 | 세션 조회가 프로필의 자격증명 유무(`credentialsReady`)를 답하고, 화면이 3초마다 물어 터미널 이벤트와 무관하게 저장을 연다. 백엔드 테스트가 파일 생성 전후를 고정한다 | 완료(사람 2026-10-10) |
| L16 | P1 | 개선 | 로그인 터미널 | 긴 OAuth 주소가 xterm에서 여러 줄로 접혀 보이고 모바일에서는 긁어 복사할 수 없어 원격 로그인이 막혔다. 일회용 코드도 마찬가지 | 2026-10-10 NAS 실측(Antigravity 주소 복사 실패로 60초 초과) | 출력 원문에서 http(s) 주소와 일회용 코드를 뽑아 터미널 위에 "브라우저에서 열기"·"주소 복사"·"코드 복사" 버튼으로 보이고, 모바일에서는 그 띠를 고정한다. 추출 규칙은 단위 테스트가 고정한다 | 완료(사람 2026-10-10) |
| L17 | P1 | 개선 | 이미지·Cypress | Cypress 애드온 실행이 `missing the dependency: Xvfb`와 공유 라이브러리 부재(libgbm1·libnss3·libasound2 등)로 시작 전에 멈춘다 | 2026-10-10 NAS 실측(cypress-smoke 작업공간, 실행 0건) | 이미지에 xvfb·xauth와 GTK/NSS/ALSA 런타임·CJK 글꼴이 들어가 `cypress verify`가 통과하고 헤드리스 스펙 1건이 돈다 | 완료(사람 2026-10-11) |
| L18 | P1 | 개선 | Cypress 애드온 | 모듈을 설치해도 브라우저 시스템 패키지 부재(L17)를 실행을 눌러서야 알게 된다 | 2026-10-10 NAS 실측, `cypress_runs.rs` 설치 경로에 점검 없음 | 설치 직후와 "환경 점검" 버튼에서 `cypress verify`를 돌려 결과와 조치(hint)를 화면에 보이고, 에이전트에도 `verify_cypress_environment` 작업이 열린다. 힌트 규칙은 단위 테스트가 고정한다 | 완료(사람 2026-10-11) |
| L19 | P1 | 개선 | 이미지·SSH | 컨테이너에 openssh-client가 없어 SSH 애드온의 키 생성(ssh-keygen)·접속(ssh)·전송(scp)이 전부 막힌다 | 2026-10-11 NAS 원격 화면 "ssh-keygen 실행 파일을 찾지 못해", 컨테이너 `which ssh ssh-keygen scp` 없음 | 이미지에 openssh-client가 들어가 원격 화면에서 Ed25519 키 생성이 되고 `ssh -V`가 실행된다 | 완료(사람 2026-10-11) |
| L20 | P2 | 개선 | 원격 판정 | 헤드리스 판정 `is_headless_host`가 수명 플래그 `--shutdown-on-stdin-eof` 부재에 얹혀 있어, 엔트리포인트나 감독자가 그 플래그를 넣는 순간 판정이 조용히 뒤집힌다 | `remote.rs:881`, 회차 보고(G01 2026-10-11), 참고 가지 `round/lane-G01-h04-duplicate` | 데스크톱 셸이 독립 플래그(예: `--desktop-shell`)를 명시해 주고 헤드리스 판정은 그 플래그와 `--tailscale-host`만 본다. `--shutdown-on-stdin-eof`는 판정에 쓰이지 않는다. 두 플래그 조합을 argv 단위 테스트가 고정한다 | 완료(G01 2026-10-11) |
| L22 | P2 | 개선 | 계정 로그인 | Codex 원격 로그인이 기기 코드 하나로 고정돼, 기기 코드 인증이 막힌 계정·조직은 원격·헤드리스에서 로그인할 길이 없었다. 브라우저 방식은 로그인 서버가 CLI 기기의 `127.0.0.1:1455`에만 떠서 콜백이 닿지 않는다 | `terminal.rs` `account_login_args`, `SettingsView.tsx` 계정 로그인 서랍 | 로그인 서랍에서 기기 코드(원격 기본)·브라우저를 고르고, 브라우저 방식은 멈춘 `127.0.0.1:1455/auth/callback?…` 주소를 붙여 넣으면 백엔드가 그 로그인 서버에 전달한다. 전달 대상은 고정 주소이고 그 로그인의 브라우저 방식 터미널이 살아 있을 때만이다. 주소 대조는 단위 테스트가, 전달은 codex-cli 0.159.2 실측(잘못된 state → HTTP 400 전달)이 확인한다 | 완료(사람 2026-10-11) |
| L21 | P3 | 개선 | 사이드카 | 커널 4.4 NAS에서 `TS_USERSPACE=true`가 실측 정상(L10)인데 compose 기본값은 `false`라 새 설치는 connmark 경고를 다시 만난다 | L10 실측 2026-10-11 | compose·`.env.example` 기본값을 `true`로 바꾸고 주석에 커널 모드를 쓰려면 `false`로 두라고 적는다 | 완료(G02 2026-10-11) |

## 재배포 실측 목록 (회차가 아니라 사람이 재배포할 때 닫는다)

| ID | 할 일 | 상태 |
| --- | --- | --- |
| L10 | `.env`에 `TS_USERSPACE=true`를 넣고 스택을 재생성한 뒤 serve·`Tailscale-User-Login` 헤더·`/api/access`가 그대로 동작하는지 실측 | 완료(2026-10-11, 전부 정상) |
| H11 | 새 이미지로 재생성 → 기동 로그에 세 CLI `씨앗 심음` 줄 → CLI 화면 경로가 `/home/agent/.local/...`이고 업데이트 버튼이 켜짐 → Claude·Codex·`agy` 업데이트 성공(`agy update`가 `~/.local/bin/agy`를 제자리에서 바꾸는지 포함) → `down`/`up -d` 뒤 버전 유지 → `AGENT_MANAGER_RESEED_CLI=1` 기동으로 씨앗 복귀 → `/usr/local/bin`에 CLI 없음 → 계정 화면 사용량 조회 정상. 끝나면 위 표 H11을 `완료(사람 YYYY-MM-DD)`로 | 대기 |

## 회차가 지키는 것

- 한 회차에 한 항목. 항목의 수용 기준만 만족시키고 멈춘다.
- `결정대기`·`보류`·`해당없음`은 고르지 않는다. 결정이 나면 사람이 `대기`로 바꾼다.
- 후보는 **레인 워크트리의 개발선 기준 목록**에서만 고른다. 주 워크트리의 사본은 뒤처지거나 앞서 있을 수 있다.
- 이 파일의 **상태 칸 한 줄을 바꾸는 것은 `reserved-paths` 예약에 걸리지 않는다**(2026-10-11 결정). 다른 칸은 예약을 따른다.
- 같은 커밋에서 이 표의 상태 칸만 고친다. 수용 기준·근거를 고쳐야 한다면 보고의 `decisions`로 넘긴다.
- 새 항목이 보이면 표에 추가하지 않고 보고의 `next`에 적는다. 표에 넣는 것은 사람이 한다.
