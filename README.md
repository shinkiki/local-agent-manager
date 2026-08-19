# Agent Manager

macOS와 Windows에서 Claude Code, OpenAI Codex, Google Antigravity의 로컬 채팅 내역을 조회·정리하고, 각 에이전트 CLI 실행까지 관리하는 Tauri 데스크톱 앱입니다.

## 구조

```text
Tauri 데스크톱 UI ──┐
브라우저/PWA UI ────┼─ HTTP/WebSocket ─→ 단일 loopback 백엔드
Tailscale 원격 UI ──┘                         ↓
                                      Rust Core
                                      ├─ AccountSupervisor
                                      ├─ chat/terminal/scheduler supervisors
                                      ├─ Agent Manager 저장소·Keychain·CLI 홈
                                      ├─ provider/session adapters
                                      ├─ transcript parsing and dashboard aggregation
                                      ├─ read-only SQLite/JSONL/filesystem access
                                      ├─ provider CLI PTY supervision
                                      └─ structured chat and approval routing
```

- React는 표시와 사용자 입력만 담당하며 모든 도메인 작업을 중앙 백엔드의 typed HTTP/WebSocket API로 보냅니다.
- Tauri는 창, 대화상자, 자동 시작, 파일 저장 같은 OS 기능과 패키징만 담당합니다. Tauri 프로세스 안에는 별도 `AccountSupervisor`를 만들지 않습니다.
- 백엔드는 계정·채팅·터미널·반복 요청과 파일·DB·CLI·보안·플랫폼 처리를 소유합니다. app-data별 소유권 잠금으로 두 백엔드가 같은 registry와 자격증명 저장소를 동시에 열 수 없습니다.
- 데스크톱 앱은 Tailscale 사용 여부와 무관하게 설정된 loopback 포트에 백엔드를 시작하고, 브라우저/PWA는 자신을 제공한 백엔드의 same-origin API를 사용합니다.
- 에이전트 원본 데이터는 읽기 전용으로 취급합니다.

## 설치 (macOS Apple Silicon)

[GitHub Releases](https://github.com/shinkiki/local-agent-manager/releases)에서 최신 `aarch64.dmg` 파일을 내려받아 열고 `Agent Manager.app`을 `Applications` 폴더로 옮깁니다. 현재 릴리스는 Apple Silicon(arm64)용입니다.

현재 배포본에는 Apple Developer ID 서명과 공증이 적용되지 않았습니다. 앱을 `Applications` 폴더로 옮긴 뒤 macOS가 실행을 차단하면 터미널에서 다음 명령으로 해당 앱의 격리 속성을 제거한 후 다시 실행합니다.

```bash
xattr -dr com.apple.quarantine "/Applications/Agent Manager.app"
```

이 명령은 설치한 `Agent Manager.app`에만 적용합니다. 시스템 전체의 Gatekeeper 설정을 끌 필요는 없습니다.

## 현재 구현

- 대시보드: 공급자별 세션·토큰·디스크·주간 추이·모델·프로젝트·최근 세션
- 세션: Claude/Codex/Antigravity 통합 검색·필터·본문 열람
- 세션 폴더: 생성·이름/색상 변경·삭제·필터와 세션 행 드래그 앤 드롭 분류
- 세션 메타데이터: 즐겨찾기·숨김·표시 제목·메모·다중 폴더 연결
- 문서: Markdown 폴더 등록·트리 탐색·읽기·편집·외부 변경 충돌 감지
- 스킬: 개인·프로젝트·플러그인·시스템·내장 `SKILL.md`와 구성 파일 탐색
- 에이전트: `~/.claude/agents` 정의와 시스템 프롬프트 열람
- 아티팩트: Antigravity 작업 목록·구현 계획·워크스루 탐색
- Claude/Codex/Antigravity CLI 및 채팅 데이터 경로 탐지
- Tauri와 분리된 `agent-manager-core` Rust crate와 typed HTTP/WebSocket API
- 번들 UI와 브라우저 UI가 함께 사용하는 단일 loopback 백엔드
- 선택 세션을 공식 공급자 CLI로 재개하는 WebSocket 터미널
- 새 CLI 대화를 시작하는 구조화 채팅: 스트리밍 메시지·도구·파일 변경·중단
- 요청별 작업 로그: 대화에는 최종 답변과 접힌 요약을 표시하고 추론·도구 실행은 별도 탭에서 탐색
- 반복 요청: 프리셋·Cron 주기, 새 채팅/동일 대화 전략, 재개 실패 정책과 실행 이력
- 설정: 공급자별 CLI·채팅 기록 탐지 상태와 설치·로그인 터미널, 채팅 위치 고정 또는 신규 메시지 자동 표시 선택
- 로그인 자동 실행·시스템 트레이 상주와 반복 실행 완료·실패·세션 전환 알림
- Codex app-server의 사용자 승인 요청을 채팅 화면에서 허용·거절
- 상단 알림 센터에서 승인 대기·작업 완료·실패를 확인하고 해당 실행 또는 세션으로 이동
- 진행 중인 세션 상세를 닫았다 다시 열어도 분리된 CLI 실행에 자동으로 재연결
- 원격 콘텐츠, Shell, 파일시스템, SQL 권한을 노출하지 않는 최소 WebView capability

파일 변경 감시는 다음 구현 단계입니다.

원본 에이전트 데이터 파일은 프로그램이 직접 수정하지 않습니다. 사용자가 채팅이나 터미널에서 공식 CLI/app-server로 새 대화를 시작하거나 기존 대화를 재개할 때 발생하는 공급자 자체 저장은 허용합니다. 앱에서 생성하는 세션 메타데이터와 문서 루트 설정은 Tauri 앱 데이터 디렉터리의 `manager-state.json`에 저장합니다. 사용자가 문서 화면에서 명시적으로 등록한 Markdown 루트만 편집할 수 있습니다.

## 개발

필수 도구:

- Node.js 22+
- Rust stable
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools 및 WebView2

```bash
npm install
npm run tauri dev
```

개발용 Tauri 앱도 자체 Core를 열지 않고 설정된 서비스 포트의 백엔드에 연결합니다. 해당 app-data를 소유한 별도 `agent-manager-server`가 이미 실행 중이면 그 서버를 사용하며, 그렇지 않으면 Tauri가 같은 실행 파일의 백엔드 모드를 자식 프로세스로 시작합니다. 창만 닫아 트레이에 숨기면 백엔드는 계속 실행되고, 앱을 완전히 종료하면 Tauri가 시작한 자식 백엔드도 종료됩니다.

초기 실행 시 로컬 대화 파일을 Rust에서 읽어 화면 스냅샷을 구성하므로 데이터 양에 따라 몇 초가 걸릴 수 있습니다.

### 백엔드 서비스 포트

데스크톱 앱의 `설정 > 백엔드 서비스 > 고급 설정`에서 `1024~65535` 범위의 포트를 지정할 수 있습니다. 신규 설치 기본값은 Dynamic/Private 범위의 `54178`이며, 기존 Tailscale/launchd 배포가 명시적으로 사용하는 `4178` 설정은 그대로 유지됩니다. 저장은 실행 중인 채팅·터미널의 연결을 바꾸지 않으며, Agent Manager를 트레이까지 완전히 종료한 뒤 다시 실행할 때 적용됩니다. 별도 `agent-manager-server` 또는 launchd 서비스를 사용한다면 앱 종료 전에 그 서비스의 `--port`도 같은 값으로 바꿔야 합니다. 일반 브라우저/PWA는 이 로컬 설정을 사용하지 않고 현재 페이지의 same-origin API에 연결합니다.

백엔드는 선택한 포트의 `127.0.0.1`에만 바인딩합니다. 포트 바인딩을 먼저 성공한 프로세스만 app-data와 Core를 열며, 별도 포트에서 같은 app-data를 다시 열려고 해도 소유권 잠금이 거부합니다.
각 app-data에는 비밀이 아닌 고정 `storeId`가 생성됩니다. 데스크톱은 `/api/access`의 API 버전과 `storeId`가 시작 시 고정한 값에 모두 일치할 때만 이미 열린 포트를 재사용합니다. 저장된 커스텀 포트에 연결할 수 없을 때의 기존 배포 포트 `4178` 호환 fallback도 같은 `storeId`가 확인된 경우로 제한됩니다.

### Tailscale 원격 접속

Tailscale은 중앙 백엔드의 필수 조건이 아니라 선택적인 원격 진입 경로입니다. Tailscale을 사용하지 않아도 데스크톱 앱의 loopback 백엔드는 항상 시작됩니다. 설치한 데스크톱 앱에서 `설정 > 백엔드 서비스 > Tailscale 서비스`를 켜면 현재 Tailscale 호스트와 사용자를 검증하고 Serve를 설정한 다음, 원격 읽기·변경·채팅·터미널을 허용하는 백엔드로 Agent Manager가 자동 재시작됩니다. 브라우저/PWA에서는 호스트 앱을 재시작할 수 없으므로 이 설정은 호스트의 데스크톱 앱에서 켭니다.

별도 서버 프로세스로 실행하거나 개발 중 어댑터만 확인하려면 정적 프런트를 빌드한 뒤 기존 CLI를 사용할 수 있습니다.

```bash
npm run build
cargo run -p agent-manager-server -- \
  --port 4178 \
  --static-dir dist \
  --tailscale-host device.tailnet.ts.net \
  --tailscale-user user@example.com
```

원격 변경·채팅·터미널을 허용할 때만 CLI에 `--remote-write`를 추가합니다. Tailscale의 사용자 대상 HTTPS 포트(기본 `443`)와 로컬 백엔드 포트는 서로 다른 계층이지만, `tailscale serve --bg 127.0.0.1:4178`의 로컬 대상 포트는 실제 백엔드 포트와 같아야 합니다. 커스텀 포트를 사용하면 CLI `--port`, 데스크톱 서비스 포트, Serve 대상을 모두 같은 값으로 맞춥니다. 원격 요청은 Tailscale Serve가 주입한 현재 사용자 로그인과 정확한 `*.ts.net` 호스트를 검증합니다. 로컬 접속은 항상 허용되며 서버는 외부 인터페이스에 직접 바인딩하지 않습니다.

별도 `agent-manager-server`나 launchd 서비스를 운영한다면 해당 프로세스를 먼저 시작하고 `/api/access`가 기대 `protocolVersion`, `storeId`, `writable` 상태를 반환하는지 확인한 뒤 데스크톱 앱을 실행합니다. 같은 포트를 먼저 점유한 호환 백엔드를 데스크톱이 재사용하며, 여러 GUI가 자동으로 백엔드 소유권을 승계하지는 않습니다.

개발 중에는 아래 명령으로 기존 Agent Manager 프런트엔드와 서비스 포트의 검증된 백엔드만 종료한 뒤, 최신 `dist`와 debug 서버를 빌드하고 백엔드→Tauri 프런트엔드 순서로 다시 시작할 수 있습니다. 포트의 기존 리스너가 Agent Manager 실행 파일이 아니면 안전을 위해 중단하며, 정상 종료가 제한 시간 안에 끝나지 않을 때만 강제 종료합니다. 명령을 `Ctrl+C`로 종료하면 이번에 시작한 프런트엔드와 백엔드를 함께 종료합니다.

```bash
# 로컬 전용
npm run tauri:dev:restart

# 현재 Tailscale 신원과 Serve 대상을 검증하고 원격 쓰기까지 활성화
npm run tauri:dev:restart:remote-write

# 기존 명령도 같은 원격 쓰기 재시작 스크립트로 연결됨
npm run tauri dev --remote-write
```

### 세션 터미널

Claude Code, Codex, Antigravity CLI가 설치되어 있고 해당 계정으로 로그인된 상태에서 세션 상세의 `터미널` 탭을 엽니다. 앱은 선택된 세션 ID와 저장된 작업 경로로 공급자의 공식 resume 명령을 실행합니다. 외부 터미널에서 이미 실행 중인 프로세스에는 붙지 않으며 Agent Manager가 시작한 실행 중 PTY만 연결 해제 후 2분 동안 재연결할 수 있습니다. CLI 프로세스가 종료된 경우에는 종료된 PTY를 재사용하지 않고 `다시 연결`에서 새 공식 resume 프로세스를 시작합니다.

채팅 기록은 탐지되지만 CLI 실행 파일이 없으면 대시보드 공급자 상태, 채팅 시작 화면, 사이드바 연결 요약 또는 `설정 > CLI 연결 상태`에서 연결 화면을 엽니다. 데스크톱 앱에서는 공급자별 설치·로그인 명령을 안내하는 설정 터미널을 직접 열 수 있으며, 완료 후 `CLI 다시 검사`로 PATH 탐지 상태를 갱신합니다.

### 구조화 채팅

`채팅` 메뉴에서 공급자, 작업 경로, 권한 모드, 승인 처리, 모델을 선택해 새 대화를 시작합니다. 권한 모드는 `읽기 전용`, `작업공간 쓰기`, `전체 접근`을 같은 선택 상자에서 제공하며, `전체 접근`을 선택하면 작업 경로 밖의 파일과 시스템 명령 접근 위험을 바로 경고합니다. 승인 처리는 `직접 승인`, Codex 전용 `자동 검토`, `승인 없이 실행`을 제공하며 새 Codex 채팅의 기본값은 `자동 검토`입니다. `승인 없이 실행`도 선택한 권한 모드의 샌드박스 경계를 넓히지는 않으므로, 모든 경계를 제거하려면 별도로 `전체 접근`을 선택해야 합니다. Codex는 공식 app-server JSON-RPC를 사용하므로 메시지·도구·파일 변경 스트리밍과 대화형 승인을 지원합니다. Claude와 Antigravity는 공식 `stream-json` CLI 출력을 사용하며, 해당 CLI가 양방향 승인 요청을 제공하지 않는 경우 기존 `세션 > 터미널`에서 이어서 승인할 수 있습니다. 구조화 채팅이 생성한 공급자 세션도 다음 세션 새로고침에서 일반 세션으로 표시됩니다. 원격 WebSocket은 20초 heartbeat를 보내고 일시적인 모바일·Tailscale 연결 종료 시 같은 채팅 런타임에 자동 재연결합니다. 위의 2분 종료 유예는 PTY 터미널에만 적용됩니다.

상단 알림 아이콘은 직접 확인이 필요한 승인 요청과 작업 완료·실패를 모아 표시합니다. 새 채팅의 승인 알림은 실행 중인 채팅으로, 기존 세션 이어가기의 승인 알림은 해당 세션 상세로 이동하며 화면을 닫은 동안에도 같은 `chatId` 런타임에 다시 연결해 승인할 수 있습니다. 앱을 완전히 종료하면 공급자 프로세스도 종료되므로 이전 실행의 승인 요청은 다시 사용할 수 없습니다.

### 반복 요청

채팅 입력창에서 `반복 요청`을 체크하거나 `채팅 > 반복 요청` 탭에서 새 작업을 등록합니다. 매 N시간·매일·평일·매주 프리셋과 `분 시 일 월 요일` 형식의 5필드 Cron을 사용할 수 있습니다. 동일 대화를 이어가는 작업은 재개 실패 시 `일시정지`, `즉시 새 대화`, `한 번 재시도 후 새 대화` 중 하나를 작업별로 선택합니다. 컴퓨터가 잠자기·종료 상태여서 놓친 회차와 이전 실행이 끝나지 않아 겹친 회차는 다시 실행하지 않습니다.

앱 창을 닫으면 시스템 트레이로 숨겨지고 반복 요청은 계속 실행됩니다. 트레이 메뉴의 `종료`를 선택해야 프로세스가 종료됩니다. 읽기 전용·작업공간 쓰기는 선택한 샌드박스 범위 안에서 무인 실행하고 범위 밖 추가 권한은 거절합니다. 전체 접근 반복 요청은 추가 권한까지 무인 승인하므로 등록·수정 시 확인이 필요합니다.

## 검증

```bash
npm run check
npm run tauri build -- --no-bundle
```

로컬 데이터 어댑터만 빠르게 점검하려면 다음 진단 명령을 사용할 수 있습니다.

```bash
cargo run -p agent-manager-core --example inspect
```

## 기여와 보안

변경 제안과 로컬 검증 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를 따릅니다. 취약점이나 자격증명 노출 가능성은 공개 이슈에 상세 내용을 남기지 말고 [보안 정책](.github/SECURITY.md)의 비공개 제보 절차를 이용해 주세요.

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다. 공개 전환 전 확인할 소유권·이력·GitHub 설정은 [공개 전환 체크리스트](docs/PUBLIC_RELEASE.md)에 정리되어 있습니다.

Claude, Claude Code, OpenAI, Codex, Google, Antigravity, Tailscale 및 관련 명칭은 각 소유자의 상표일 수 있습니다. 이 프로젝트는 해당 회사가 공식적으로 보증하거나 제휴한 제품이 아닙니다.
