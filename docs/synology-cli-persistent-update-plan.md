# 계획서: 헤드리스(시놀로지) 컨테이너에서 이미지 재빌드 없이 에이전트 CLI 업데이트

- 작성: 2026-10-15
- 대상 배포: `deploy/synology/` (Dockerfile · entrypoint.sh · docker-compose.yml · README.md)
- 관련 백로그: `docs/headless-linux-gaps.md` H11 (완료 처리된 "이미지 재빌드로 갱신" 안내를 이 작업이 뒤집는다)
- 작업자 전제: `AGENTS.md` 전체(특히 G8·G9·G10, C2, 8절 검증, 9절 커밋)를 먼저 읽는다.

## 1. 목표

NAS 컨테이너 안의 Claude Code · Codex · Antigravity(`agy`) CLI를 **이미지 재빌드 없이**, 앱의
기존 "CLI 업데이트" 버튼(`cli_updates.rs`)으로 올릴 수 있게 한다. 올린 버전은 컨테이너 재시작은
물론 **컨테이너 재생성(`docker compose down/up`, 이미지 교체)** 뒤에도 유지되어야 한다.

## 2. 현재 구조와 막히는 지점 (2026-10-15 실측·코드 확인)

| 사실 | 근거 |
|---|---|
| Claude·Codex는 빌드 시 `npm install -g`로 `/usr/local/lib/node_modules`에, `agy`는 `/usr/local/bin`에 설치된다. 모두 root 소유, 이미지 레이어(볼륨 아님) | `Dockerfile` 89–99행 |
| 서버와 CLI는 비root `agent`로 돈다(L13). 그래서 앱이 `npm install -g …@latest`를 실행하면 권한 오류 | `entrypoint.sh` `drop_privileges`, `cli_updates.rs` `run_update_command` |
| `DISABLE_AUTOUPDATER=1`로 Claude 자동 업데이트를 꺼 두었다. `agy` 백그라운드 업데이트는 `AGY_CLI_DISABLE_AUTO_UPDATE=1`로 백엔드가 막는다 | `Dockerfile` 117행, `antigravity_usage.rs` `no_auto_update_env` |
| `/home/agent`는 compose에서 `./data/home` **볼륨**이다 → 여기 둔 것은 재생성 후에도 남는다 | `docker-compose.yml` 96행 |
| CLI 탐색 순서: 프로세스 PATH(현재 `/usr/local/bin`이 앞) → 로그인 셸 PATH → `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`. 그래서 `~/.local/bin`에 새 버전을 깔아도 이미지 쪽 구버전이 먼저 잡힌다 | `providers.rs` 98–101행, `common_executable_dirs` |
| 설치 출처 판정은 실행 파일 경로 구조로 한다: 경로에 `node_modules`가 있으면 `NpmGlobal`(→ `npm install -g <pkg>@latest`), 아니면 `Standalone`(→ `<exe> update`) | `cli_updates.rs` `classify_install_source`, `plan_update` |
| 자식 프로세스는 부모 환경을 상속하고 `PATH`만 탐색 경로로 덮어쓴다 → `NPM_CONFIG_PREFIX`를 서버 환경에 두면 `npm install -g`도 그 prefix를 쓴다 | `cli_interface.rs` `capped_command` |
| 헤드리스에서는 프런트가 업데이트 버튼을 막고 "이미지 재빌드" 안내만 보인다 | `src/lib/cliUpdate.ts` `headlessImage`, `CLI_HEADLESS_IMAGE_HINT` |
| 현재 `/home/agent/.profile`은 `~/.local/bin`을 PATH에 넣지 않는 161바이트짜리 기본 파일이다. `/home/agent/.local/bin`에는 zig 심(`zig-cc` 등)만 있다 | NAS 실측 |

## 3. 설계

### 3.1 사용자 소유 prefix를 하나로 정한다

- prefix: **`/home/agent/.local`** (`$HOME/.local`). 실행 파일은 `~/.local/bin`, npm 패키지는
  `~/.local/lib/node_modules`에 둔다. 이 경로는 이미 백엔드 탐색 후보이고 볼륨 안이다.
- `Dockerfile`의 `ENV`에 다음 두 줄을 넣는다.
  - `NPM_CONFIG_PREFIX=/home/agent/.local`: 앱 업데이트 버튼의 `npm install -g`가 이 prefix에 쓴다.
  - `PATH=/home/agent/.local/bin:$PATH`: 서버 프로세스 PATH에서 이 경로가 `/usr/local/bin`보다 **앞**에 오게 한다.
- `HOME`은 엔트리포인트가 `getent passwd`로 다시 정하지만 이미지는 `/home/agent`로 고정이다. 혹시
  다르면 경고만 남기도록 엔트리포인트에서 한 번 확인한다(필수는 아님).

### 3.2 이미지에는 "씨앗"만 둔다

- 빌드 단계에서 CLI를 `/usr/local`이 아니라 씨앗 prefix **`/opt/agent-manager/cli-seed`**에 설치한다.
  - `npm install -g --prefix /opt/agent-manager/cli-seed "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"`
  - `curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/agent-manager/cli-seed/bin`
    (먼저 `agy` 설치 스크립트가 `--dir` 말고 다른 위치(예: `~/.antigravity`)에도 파일을 쓰는지 확인한다.
    쓴다면 그 경로도 씨앗에 포함하거나 계획을 고친다.)
  - npm이 만든 `bin/` 링크는 상대 경로(`../lib/node_modules/...`)여야 복사 후에도 산다. 빌드 로그에서 `ls -l`로 확인한다.
- `/usr/local/bin`에는 CLI를 더 두지 않는다. 남겨 두면 탐색 실패 시 조용히 구버전으로 돌아가므로
  **일부러 없앤다**. `node`·`npm`·`npx`는 지금처럼 `/usr/local`에 둔다(런타임이지 업데이트 대상이 아님).

### 3.3 엔트리포인트가 처음 한 번 씨앗을 심는다

- 위치: `drop_privileges` **뒤**, 즉 `agent` 사용자로 도는 구간에 둔다(root가 볼륨에 파일을 만들면
  소유권 문제가 생긴다). `require …` 검사 다음, 볼트 기동 전이면 된다.
- CLI별로 따로 판단한다(`claude`, `codex`, `agy`).
  - `~/.local/bin/<cli>`가 **없을 때만** 씨앗에서 복사한다. npm 패키지는 `lib/node_modules/<pkg>` 디렉터리와
    `bin/<cli>` 링크를, `agy`는 실행 파일 하나를 복사한다. `cp -a`로 링크를 보존하고, 임시 이름으로 복사한 뒤 `mv`해서 반쯤 복사된 상태를 남기지 않는다.
  - 이미 있으면 **건드리지 않는다.** 사용자가 앱에서 올린 버전이 이미지 씨앗보다 우선이다.
  - 씨앗 버전과 설치된 버전을 한 줄씩 로그에 남긴다(`<cli> --version`, 실패해도 기동은 계속).
- 다시 심는 스위치: 환경변수 `AGENT_MANAGER_RESEED_CLI=1`이면 세 CLI를 씨앗으로 덮는다. 앱에서 올린
  버전이 깨졌을 때 되돌리는 길이다. compose 주석과 README에 적는다.
- **결정 필요(사람):** 이미지 씨앗이 설치본보다 *새* 버전일 때 자동으로 덮을지. 기본안은 "덮지 않는다
  (사용자 업데이트 우선, 재심기 스위치로만 교체)"이다. 이렇게 하면 버전 비교 로직이 필요 없다.

### 3.4 자동 업데이트 정책은 그대로 둔다

- `DISABLE_AUTOUPDATER=1`과 `AGY_CLI_DISABLE_AUTO_UPDATE=1`은 **유지**한다. 업데이트는 사람이 버튼을
  누를 때만 한다(매 턴 백그라운드 업데이트와 진행 중 채팅의 실행 파일 교체를 피한다).
- 업데이트 전에 관리 중인 채팅·터미널을 멈추는 기존 흐름(C2-4와 같은 순서)은 바꾸지 않는다.

### 3.5 앱 쪽 변경

1. **백엔드 판정 확인(코드 변경이 없어야 정상).**
   - `~/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` → `NpmGlobal`,
     패키지 `@anthropic-ai/claude-code`. `.../@openai/codex/bin/codex.js` → `NpmGlobal`, `@openai/codex`.
     `~/.local/bin/agy` → `Standalone` → `agy update`. 해당 경로로 `classify_install_source` 단위
     시험을 하나 추가해 고정한다(기존 `/Users/x/.local/lib/node_modules/...` 시험과 같은 모양).
   - `npm install -g`가 `NPM_CONFIG_PREFIX`를 따르는지는 백엔드가 환경을 상속하므로 별도 코드가 없다.
     G8에 따라 백엔드가 이 변수를 **읽거나 저장하지 않는다**(상속만 한다).
   - `agy update`가 `~/.local/bin/agy`를 제자리에서 교체하는지, 다른 곳에 설치하는지 컨테이너에서
     실측한다. 다른 곳에 깐다면 Antigravity만 업데이트 방식을 "공식 설치 스크립트 `--dir ~/.local/bin`"
     으로 바꾸는 별도 안을 사람에게 올린다(그 경우 G9: 셸 문자열 실행 금지라 앱에서 `curl | bash`는 불가하다).
2. **프런트 헤드리스 차단 해제(H11 뒤집기).**
   - `src/lib/cliUpdate.ts`의 `headlessImage` 차단은 "CLI가 사용자 prefix에 있어 업데이트 가능"할 때
     풀려야 한다. 차단 여부를 프런트가 추측하지 않게, 백엔드 업데이트 상태에 이미 있는
     `update_method`/`unsupported_reason`을 그대로 따르게 바꾸는 것이 기본안이다. 헤드리스라는 이유만으로 막는 분기를 지운다.
   - 구 이미지(아직 `/usr/local`에 설치된 경우)는 업데이트가 권한 오류로 끝난다. 백엔드에서 실행 파일의
     상위 prefix에 쓸 수 없으면 `Unsupported`와 사유("이미지에 고정된 설치본입니다. 새 이미지로 한 번
     재생성하면 앱에서 업데이트할 수 있습니다")를 돌려주는 검사를 `plan_update`에 넣는다.
     쓰기 가능 여부는 `access(W_OK)` 또는 메타데이터로 판단하고, 파일을 만들어 보는 방식은 쓰지 않는다.
   - `docs/headless-linux-gaps.md` H11의 상태와 수용 기준을 새 동작으로 고친다.
3. **AIA 카탈로그(7절).** 업데이트 명령의 이름과 인자가 바뀌지 않으면 카탈로그 변경은 없다. `limits`
   문구에 "헤드리스는 재빌드"라고 적힌 곳이 있으면 함께 고친다(`grep -n 재빌드 crates/agent-manager-core/src/system_mcp.rs`).

### 3.6 문서

- `deploy/synology/README.md`에 다음을 적는다: CLI는 `./data/home/.local`에 있고 앱에서 업데이트한다는 점,
  `AGENT_MANAGER_RESEED_CLI=1`로 되돌리는 법, 이미지 재빌드는 씨앗만 바꾼다는 점.
- `Dockerfile` 89–117행 주석(“헤드리스 서버는 나중에 설치할 길이 없고…”, “자동 업데이트를 할 수 없다”)을 새 구조에 맞게 고친다.

## 4. 기존 NAS 전환 순서 (운영자가 하는 일)

1. 앱에서 진행 중인 채팅·회차가 없을 때 진행한다.
2. 새 이미지 빌드 → `docker compose up -d` (재생성).
3. 기동 로그에서 세 CLI의 "씨앗 심음 + 버전" 줄을 확인한다.
4. 앱 설정의 CLI 화면에서 세 CLI 경로가 `/home/agent/.local/...`로 보이고 업데이트 버튼이 켜져 있는지 확인한다.
5. 기존 로그인 상태(`~/.claude`, `~/.codex`, `~/.gemini`, 키링)는 HOME 볼륨에 있으므로 그대로여야 한다. 계정 화면에서 사용량 조회가 되는지 확인한다.

## 5. 수용 기준

- [ ] 새 볼륨(빈 `./data/home`)으로 처음 기동하면 세 CLI가 `~/.local`에 심기고 채팅이 동작한다.
- [ ] 앱의 CLI 업데이트 버튼이 헤드리스에서 켜지고, Claude·Codex는 `npm install -g`로, `agy`는 `agy update`로 성공한다.
- [ ] 업데이트 후 `docker compose down && up -d`를 해도 올린 버전이 유지된다.
- [ ] `AGENT_MANAGER_RESEED_CLI=1`로 기동하면 씨앗 버전으로 돌아간다.
- [ ] `/usr/local/bin`에 `claude`·`codex`·`agy`가 없다(`docker exec … ls`).
- [ ] 구 이미지 구조(설치본이 쓰기 불가)에서는 버튼 대신 재생성 안내가 나온다.
- [ ] `classify_install_source` 신규 시험과 기존 `cli_updates::` 시험이 통과한다.

## 6. 검증 (AGENTS.md 8절)

- Rust: `cargo test -q -p agent-manager-core --lib cli_updates::` (1단계). 다른 모듈을 건드렸으면 2단계.
- 프런트: `node --experimental-strip-types --test --test-reporter=dot src/lib/*.test.mjs`, 마지막에 `npx tsc --noEmit` 한 번.
- 포맷: `cargo fmt --all` 후 `cargo fmt --all --check`.
- 컨테이너: `deploy/synology/test-privdrop.sh`가 엔트리포인트 변경 뒤에도 통과하는지 확인한다. 씨앗 심기 분기(없음/있음/재심기)를 같은 방식의 스크립트 시험으로 추가한다.
- NAS 실측(사람 또는 회차): 5절의 업데이트·재생성 유지 항목. 실측 전까지 백로그 상태는 `보류`로 둔다.

## 7. 하지 않는 것

- CLI 자동 업데이트를 켜지 않는다.
- 앱이 `curl | bash` 같은 셸 문자열을 실행하게 만들지 않는다(G9).
- 공급자 홈(`~/.claude`, `~/.codex`, `~/.gemini`)의 설정·세션 파일을 옮기거나 고치지 않는다(G2).
- 데스크톱(macOS·Windows) 경로의 업데이트 동작은 바꾸지 않는다. 바뀌는 것은 컨테이너 배포와 헤드리스 판정뿐이다.

## 8. 위험과 대응

| 위험 | 대응 |
|---|---|
| 업데이트가 중간에 실패해 `~/.local`의 CLI가 깨짐 | 재심기 스위치로 씨앗 복구. README에 절차를 적는다 |
| 볼륨 소유권 불일치(PUID 변경) | 엔트리포인트의 기존 `chown -R HOME`이 처리한다. 씨앗 심기는 그 뒤 agent 권한으로 한다 |
| 새 Claude 버전이 Node 요구 버전을 올림 | Node는 이미지가 정한다. 업데이트 실패 시 사유가 영수증에 남는지 확인하고, Node 업데이트는 이미지 재빌드로 한다고 README에 적는다 |
| `agy update`가 다른 경로에 설치 | 3.5-1의 실측으로 먼저 확인하고, 다르면 사람 결정으로 넘긴다 |
| 진행 중 채팅이 쓰는 실행 파일이 교체됨 | 업데이트 전에 관리 런타임을 멈추는 기존 흐름이 처리한다. 무인 회차 시간대를 피해 실행한다 |
