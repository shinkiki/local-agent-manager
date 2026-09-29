# 공증본 스모크 점검 (macOS)

Developer ID 서명·공증한 macOS 배포본이 **하드닝 런타임 때문에 기능을 잃지 않았는지** 확인하는 절차다.
빌드·서명 절차 자체는 [scripts/macos/APPLE_RELEASE_SIGNING.md](../scripts/macos/APPLE_RELEASE_SIGNING.md)에 있다.

왜 따로 필요한가: 빌드가 성공하고 공증이 Accepted여도 실행은 별개다. 하드닝 런타임은 자식 프로세스
실행, 동적 라이브러리 적재, 마이크 같은 자원 접근을 서명 시점의 엔타이틀먼트로 통제한다. Agent Manager는
공급자 CLI를 자식으로 띄우고, PTY를 열고, `/usr/bin/security`로 Keychain을 읽고, WKWebView 안에서
마이크를 연다 — 전부 서명 후에 조용히 죽을 수 있는 경로다.

릴리스마다 돌린다. 소요는 5분 안쪽이다.

## 0. 준비

공증·staple까지 끝난 DMG로 `/Applications`에 설치하고 앱을 실행한 상태여야 한다. 설치 과정에서
`xattr -dr com.apple.quarantine`류의 조작을 하면 이 점검의 의미가 없어진다 — 그 조작 없이 열려야 한다.

백엔드는 `127.0.0.1:4178`에서 듣는다. 아래 명령은 그 **실행 중인 설치본**에 직접 묻는다.
로컬 루프백 요청은 인증이 없으므로 UI를 거치지 않고 관찰할 수 있다. 명령 이름은 `src/lib/ipc.ts`의
호출 이름과 같다.

## 1. 설치본 정체성

점검 대상이 정말 공증된 그 빌드인지부터 고정한다.

```sh
codesign -dv --entitlements - "/Applications/Agent Manager.app" 2>&1 | grep -E "flags|TeamIdentifier|\[Key\]"
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
xcrun stapler validate "/Applications/Agent Manager.app"
```

기대: `flags=0x10000(runtime)`, `source=Notarized Developer ID`, `The validate action worked!`,
엔타이틀먼트는 `com.apple.security.device.audio-input` 하나.

`flags=0x0(none)`이면 하드닝 런타임이 꺼진 빌드이므로 이 점검 전체가 무의미하다.

## 2. CLI 탐지

```sh
curl -s -X POST http://127.0.0.1:4178/api/invoke/get_app_status \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool | grep -A2 '"cli"'
```

기대: 설치해 둔 공급자마다 `detected: true`와 실행 파일 경로.

## 3. CLI 실행 (자식 프로세스)

탐지는 파일 존재만 봐도 되지만, 이 명령은 실행 파일을 실제로 돌려 `--version`을 읽는다.

```sh
curl -s -X POST http://127.0.0.1:4178/api/invoke/get_cli_update_status \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool | grep -E '"currentVersion"|"provider"'
```

기대: 공급자마다 `currentVersion`이 채워진다. `null`이면 자식 프로세스 실행이 막힌 것이다.

## 4. Keychain 계정 조회

```sh
curl -s -X POST http://127.0.0.1:4178/api/invoke/get_provider_accounts \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys,collections; d=json.load(sys.stdin); a=d if isinstance(d,list) else d.get('accounts',[]); print(collections.Counter((x.get('provider'),x.get('authStatus')) for x in a))"
```

기대: 등록해 둔 계정이 모두 `ready`. `authStatus`는 Vault를 읽어야 정해지므로, 이게 나오면
`/usr/bin/security` 경로가 살아 있다는 뜻이다.

**주의**: `revalidate_provider_account_credential`이나 `refresh_provider_account_usage`로 대신하지 않는다.
볼트를 갱신해 홈 CLI의 리프레시 토큰을 무효화할 수 있다.

## 5. 터미널 PTY

셸을 띄우고 명령이 실제로 실행되는지 본다. 출력 프레임은 JSON이 아니라 원문이다.

```js
// node smoke-pty.mjs  (저장소 루트에서 실행)
import WebSocket from './node_modules/ws/index.js';
const ws = new WebSocket('ws://127.0.0.1:4178/api/terminal', { origin: 'http://127.0.0.1:4178' });
const marker = 'SMOKE' + Date.now();
let out = '', sent = false;
const finish = (code, msg) => { console.log(msg); try { ws.send(JSON.stringify({type:'stop'})); ws.close(); } catch {} setTimeout(()=>process.exit(code), 300); };
const timer = setTimeout(() => finish(1, '실패: 마커 미출력\n' + out.slice(-400)), 12000);
ws.on('open', () => ws.send(JSON.stringify({ type: 'open', request: { source: 'claude', cols: 80, rows: 24 } })));
ws.on('message', (raw) => {
  const s = raw.toString();
  if (s.startsWith('{"type":"state"')) return;
  out += s;
  if (!sent) { sent = true; setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `printf '%s\\n' ${marker}\n` })), 500); }
  if (out.split(marker).length > 2) { clearTimeout(timer); finish(0, '성공: PTY 셸이 명령을 실행했다'); }
});
ws.on('error', (e) => finish(1, '실패: ' + e.message));
```

마커가 **두 번 이상** 나와야 통과다 — 한 번은 입력 에코이고, 두 번째가 실행 결과다.
`source`는 `cli-setup` 세션을 쓰므로 사용자가 열어 둔 터미널을 건드리지 않는다. `stop`으로 닫는다.

## 6. 채팅 1턴

공급자 CLI를 자식으로 띄우고 모델 응답까지 받는, 가장 무거운 경로다. 공급자 사용량을 조금 쓴다.

```sh
mkdir -p /tmp/am-smoke
curl -s -X POST http://127.0.0.1:4178/api/invoke/start_chat -H 'Content-Type: application/json' -d '{
  "request": {
    "chat": { "source": "claude", "cwd": "/tmp/am-smoke", "model": null, "mode": "plan" },
    "message": "Reply with exactly: SMOKE-OK",
    "idempotencyKey": "smoke-1"
  }
}'
```

`idempotencyKey`는 매번 새 값으로 준다. 돌려받은 `chatId`로 자식이 떴는지 확인한다.

```sh
pgrep -fl claude.exe            # 또는 codex / agy
lsof -a -p <pid> -d cwd -Fn     # n/private/tmp/am-smoke 이면 이 채팅의 자식이다
```

응답 확인은 `/api/chat` 소켓에 붙어 리플레이를 읽는다. `get_chat_last_turn_output`은 무인 채팅
전용이라 여기서는 거부된다.

```js
// node smoke-chat.mjs <chatId>
import WebSocket from './node_modules/ws/index.js';
const chatId = process.argv[2];
const ws = new WebSocket('ws://127.0.0.1:4178/api/chat', { origin: 'http://127.0.0.1:4178' });
const finish = (code, msg) => { console.log(msg); try { ws.send(JSON.stringify({type:'detach'})); ws.close(); } catch {} setTimeout(()=>process.exit(code), 200); };
setTimeout(() => finish(1, '실패: 20초 안에 응답 없음'), 20000);
ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', chatId })));
ws.on('message', (raw) => { if (raw.toString().includes('SMOKE-OK')) finish(0, '성공: 모델 응답 수신'); });
ws.on('error', (e) => finish(1, '실패: ' + e.message));
```

끝나면 반드시 정리한다.

```sh
curl -s -X POST http://127.0.0.1:4178/api/invoke/stop_chat \
  -H 'Content-Type: application/json' -d '{"chatId":"<chatId>"}'
rm -rf /tmp/am-smoke
```

## 7. 음성 입력 (사람만 가능)

채팅 작성기의 눌러서 말하기를 눌러 마이크 권한 대화상자를 수락하고, 한 문장이 글로 옮겨지는지 본다.
자동화할 수 없다 — 권한 대화상자와 실제 발화가 필요하다.

서명 후 마이크가 막히는 것은 전형적인 실패 지점이다. 1절에서 `com.apple.security.device.audio-input`이
번들에 들어간 것을 봤더라도, 실제 녹음은 따로 확인한다.

## 결과 기록

2026-09-15에 0.2.0 공증본으로 1~7절을 모두 통과했다. 하드닝 런타임에서 자식 프로세스 실행·PTY·
`/usr/bin/security` Keychain 접근에는 **추가 엔타이틀먼트가 필요 없다**는 것이 이때 실측으로 확인됐다.

어느 절이 실패하면 엔타이틀먼트를 늘리기 전에 무엇이 막혔는지부터 본다. 크래시 로그의
`EXC_CRASH (SIGKILL (Code Signature Invalid))`와 `log stream --predicate 'subsystem == "com.apple.TCC"'`가 단서다.
