# 시놀로지 NAS 배포 (헤드리스 서버)

Agent Manager 데스크톱 앱은 웹뷰가 필요해 NAS에서 돌지 않는다. 여기서 배포하는 것은
`agent-manager-server` 백엔드와 정적 UI뿐이고, 브라우저로 접속해서 쓴다.

## 전제

- **x86_64 시놀로지 모델**. ARM 모델(DS220j 등)은 메모리와 아키텍처 양쪽에서 대상이 아니다.
- Container Manager(도커)와 `docker compose` 사용 가능.
- `/dev/net/tun` 사용 가능(Tailscale 사이드카에 필요).
- Tailscale 계정과 auth key.

## 구조

```
[tailnet] --https--> tailscale 사이드카 --127.0.0.1:4178--> agent-manager
                     (같은 network namespace)
```

두 컨테이너가 네트워크 네임스페이스를 공유하므로 서버는 루프백에만 바인딩한 채로 동작한다.
NAS의 LAN에는 아무 포트도 열리지 않는다.

인증은 서버가 직접 판정한다. 루프백 Host 헤더이거나, `tailscale serve`가 붙여 주는
`Tailscale-User-Login` 헤더가 `TAILSCALE_USER`와 일치해야 한다.

> **하지 말 것**: 리버스 프록시로 Host 헤더를 `127.0.0.1`로 바꿔 넣는 구성. 그 경로는
> 서버가 로컬 요청으로 판단해 **인증 없이 전체 쓰기 권한**을 내준다. Funnel도 켜지 않는다.

## 설치

```sh
cp deploy/synology/.env.example deploy/synology/.env
# .env 를 채운다 (TS_AUTHKEY, TAILSCALE_HOST, TAILSCALE_USER, KEYRING_PASSWORD)

# 이미지 빌드는 x86_64 개발 머신에서 하는 편이 빠르다. NAS에서 직접 빌드하려면
# 메모리 8GB 이상을 권장한다 (Rust 릴리스 빌드).
docker compose -f deploy/synology/docker-compose.yml build

docker compose -f deploy/synology/docker-compose.yml up -d
```

`TAILSCALE_HOST`는 사이드카가 tailnet에 붙은 뒤 확정된다. 처음에는 사이드카만 올려
MagicDNS 이름을 확인하고 `.env`에 적은 다음 `agent-manager`를 올리면 된다.

```sh
docker compose -f deploy/synology/docker-compose.yml up -d tailscale
docker compose -f deploy/synology/docker-compose.yml exec tailscale tailscale status
```

## 반드시 지켜야 하는 설정

| 설정 | 이유 |
|---|---|
| `init: true` | 에이전트 CLI의 고아 자식을 PID 1이 회수해야 한다. 없으면 좀비가 쌓이고 프로세스 그룹 종료 확인이 끝나지 않아 채팅 강제 종료가 멈춘다. |
| `procps` 설치 | 관리 프로세스 신원 확인과 외부 프로세스 목록 조회가 `ps`를 부른다. |
| dbus + gnome-keyring | 리눅스 자격증명 볼트는 secret-service를 쓴다. 없으면 서버는 뜨지만 공급자 계정이 전부 실패한다. |
| 전용 사용자(`PUID`/`PGID`) | 서버·키링·CLI는 root로 돌지 않는다. Claude CLI가 uid 0에서 `--dangerously-skip-permissions`를 거부해 전체 접근 채팅이 exit 1로 끝난다. 엔트리포인트가 root로 `/data`·HOME 소유권만 맞춘 뒤 `setpriv`로 내려간다. |

`./data/home`은 이제 컨테이너의 `/root`가 아니라 `/home/agent`에 붙는다. 호스트 폴더는
그대로이므로 기존 계정·세션은 유지되고, 엔트리포인트가 첫 기동에 소유권을 `PUID:PGID`로
맞춘다. 공유 폴더 파일이 1000이 아닌 uid 소유라면 `.env`에 그 값을 `PUID`/`PGID`로 적는다.

## 보안상 감안할 점

`KEYRING_PASSWORD`로 기동 시 자동 잠금 해제하는 구성이라, **NAS 디스크와 compose 환경을
확보한 사람은 저장된 공급자 자격증명을 열 수 있다.** macOS Keychain이 사용자 로그인에
묶여 있는 것과는 보호 수준이 다르다. `./data`와 `.env`를 같은 등급으로 보호해야 한다.

기존 맥에 저장된 자격증명은 이 볼트로 옮겨지지 않는다. NAS에서 공급자 계정을 새로 등록해야 한다.

## 검증 상태

리눅스 컨테이너에서 실측으로 확인한 것:

- `agent-manager-core` / `agent-manager-server` 빌드 및 전체 테스트 통과
- x86_64 릴리스 바이너리 생성 (glibc 2.36 기준, bookworm)
- 서버 기동, `/api/access`·계정 조회 정상 응답
- dbus + gnome-keyring 조합으로 시크릿 서비스 읽기/쓰기 성공
- `init` 없이는 프로세스 그룹 종료가 멈추고, 있으면 통과
- 전용 사용자(uid 1000)로 내려간 뒤에도 dbus + gnome-keyring 잠금 해제와 secret-service
  읽기/쓰기가 동작(`~/.local/share/keyrings`가 그 사용자 소유로 생성됨)
- 엔트리포인트의 권한 내리기: `deploy/synology/test-privdrop.sh`(docker 필요)가 실제
  컨테이너에서 서버가 받은 uid/gid·HOME·argv로 판정한다. `PUID=0` 거부와 소유권 실패 시
  중단도 같은 시험이 본다.

2026-10-10~11 시놀로지 NAS(DSM 7.3.2, x86_64, 커널 4.4)에서 실제로 확인한 것:

- compose 스택 전체 기동. Tailscale 사이드카의 tailnet 가입, `serve.json` 적용, TLS 인증서 발급,
  `Tailscale-User-Login` 신원 헤더로 서버 인증, tailnet 안 다른 기기의 브라우저 접속.
- 에이전트 CLI 헤드리스 로그인. Claude(브라우저 인증 뒤 코드 붙여넣기), Codex(기기 코드),
  Antigravity(구글 동의 뒤 코드를 60초 안에 전송) 세 계정 등록. 원격 탭이 CLI 종료 이벤트를 놓쳐도
  백엔드의 자격증명 판정으로 저장할 수 있다.
- 전용 사용자 기동(L13). `PUID`/`PGID`로 내려간 뒤 `IS_SANDBOX` 없이 전체 접근 채팅 1턴이 정상 종료.
- Cypress 작업공간 등록·모듈 설치·`cypress verify`·헤드리스 스펙 실행(xvfb 포함 이미지).
- 데이터 볼륨 이동. `data/`·`workspace/`를 다른 볼륨의 절대 경로로 옮기고 재생성해도 계정·세션 유지.
- **`TS_USERSPACE=true` 전환(L10, 2026-10-11)**. 사용자 공간 모드에서 tailnet 가입·`serve` 프록시·
  `Tailscale-User-Login` 신원 헤더·`/api/access`가 모두 정상이고, 커널 4.4에서 나던 iptables
  connmark Health 경고가 사라진다. 그래서 기본값을 이쪽으로 옮겼다(L21). 커널 모드로 쓰려면
  `.env`에 `TS_USERSPACE=false`를 적는다. `devices: /dev/net/tun`과 `cap_add`는 그대로 두므로
  전제조건은 바뀌지 않는다.

아직 확인하지 못한 것:

- **외부 플러그인 OAuth를 원격에서 끝내기**. 기기 코드(H03)와 콜백 주소 붙여넣기(H13) 모두 코드는
  들어갔고 NAS 실측이 남았다. 콜백형은 승인 뒤 멈춘 `127.0.0.1:<포트>/callback?…` 주소를 인증 창에 붙여 넣는다.
- **Codex 브라우저 방식 로그인(L22)**. 계정 추가에서 "브라우저"를 고르면, 승인 뒤 멈춘
  `127.0.0.1:1455/auth/callback?…` 주소를 붙여 넣어 백엔드가 컨테이너 안 로그인 CLI에 전달한다.
  기기 코드 방식은 그대로 기본값이다.
