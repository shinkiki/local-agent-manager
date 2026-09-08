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

아직 확인하지 못한 것:

- **이 compose 스택 전체의 기동**. Tailscale 사이드카와 실제 tailnet 연결, `serve.json`
  적용, 신원 헤더 주입까지는 검증하지 않았다.
- **에이전트 CLI 헤드리스 로그인**. 컨테이너에 `claude`를 설치하지만, OAuth 로그인은
  브라우저가 필요해 토큰 주입 경로를 따로 마련해야 한다.
- **실제 채팅 세션 실행**. 서버가 뜨는 것과 에이전트가 도는 것은 별개다.
