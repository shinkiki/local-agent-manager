---
name: ssh-endpoints
description: Agent Manager 설정에서 "에이전트 사용"을 켜 둔 SSH 인증키로 원격 서버에 접속해 작업한다. "서버에 접속해서", "원격 서버 로그 확인", "배포 서버에서 실행", "저 장비에 ssh로 붙어서" 같은 요청이나, 어떤 키·계정으로 접속해야 하는지 모를 때 사용한다. 로컬 작업만 필요할 때는 쓰지 않는다.
---

# 허용된 SSH 연결 서버로 접속하기

사용자가 Agent Manager의 애드온 → SSH에서 인증키마다 연결 서버를 적고
**에이전트 사용**을 켜 둔 것만 이 목록에 나온다. 목록에 없는 서버·키는 사용자가 열어 주지
않은 것이므로 접속하지 않는다.

## 실행 파일 찾기

```sh
eval "$(python3 -c 'import json,os,shlex
p=os.path.expanduser("~/Library/Application Support/com.shinc.agentmanager/session-read-cli-v1.json")
d=json.load(open(p))
print("CLI=" + shlex.quote(d["executable"]))
print("CLI_PREFIX=" + shlex.quote(" ".join(d.get("argvPrefix", []))))')"
```

이후 호출은 항상 `"$CLI" $CLI_PREFIX ssh ...` 형태로 쓴다. 데스크톱 앱은 자기 바이너리를
`--backend`로 다시 띄워 백엔드를 돌리므로, 접두사를 빼면 실행 파일이 `ssh`를 받지 않는다.

파일이 없으면 Agent Manager 백엔드가 한 번도 실행되지 않은 것이다. 그때는 사용자에게
Agent Manager를 실행해 달라고 말하고, 추측으로 다른 경로를 찾지 않는다.

## 목록 받기

```sh
"$CLI" $CLI_PREFIX ssh list
```

```json
{
  "schemaVersion": 1,
  "endpoints": [
    {
      "fingerprint": "SHA256:…",
      "keyFileName": "id_deploy",
      "identityPath": "/Users/me/.ssh/id_deploy",
      "host": "build.example.com",
      "port": 22,
      "user": "deploy",
      "note": "사내 빌드 서버",
      "destination": "deploy@build.example.com:22",
      "sshArgs": ["-i", "/Users/me/.ssh/id_deploy", "-p", "22", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "deploy@build.example.com"],
      "sshCommand": "ssh -i /Users/me/.ssh/id_deploy -p 22 -o IdentitiesOnly=yes -o BatchMode=yes deploy@build.example.com",
      "commandPolicyMode": "allowlist",
      "allowedCommands": ["ls", "tail", "systemctl status", "git pull"],
      "deniedCommands": ["rm -rf", "reboot", "cat /etc/shadow"],
      "fileTransferEnabled": true,
      "transferRoot": "/srv/releases",
      "terminalEnabled": true,
      "unrestrictedCommands": false,
      "relayArgs": ["ssh", "exec", "--fingerprint", "SHA256:…", "--"]
    }
  ],
  "skipped": [{"fingerprint": "SHA256:…", "reason": "…"}],
  "issues": []
}
```

- `endpoints`가 비어 있으면 **쓸 수 있는 서버가 없는 것이다.** 다른 키를 찾거나 `~/.ssh`를
  뒤지지 말고, 사용자에게 애드온 → SSH에서 연결 서버를 적고 "에이전트 사용"을
  켜 달라고 말한다.
- `skipped`는 사용자가 켜 두었지만 지금은 쓸 수 없는 항목이다(개인키 없음, 키 삭제됨).
  이유를 그대로 사용자에게 전한다.
- `note`는 사용자가 이 키에 적어 둔 메모다. 어느 서버인지 고를 때의 근거로 쓴다.
- `fileTransferEnabled`는 이 서버로 **파일을 올리고 받아도 되는지**이고, `transferRoot`가 그
  폴더다. 명령 목록과 **별개의 권한**이라 명령이 하나도 허용되지 않은 서버에 산출물만
  주고받게 해 둘 수도 있다. 꺼져 있으면(또는 `transferRoot`가 비어 있으면) 파일을 옮기지 않고
  사용자에게 애드온 → SSH → 연결 서버에서 파일 전송을 켜 달라고 말한다.
  켜져 있어도 대상은 **두 방향 모두** `transferRoot` 아래로만 정하고 `..`나 절대 경로로 그
  폴더를 벗어나지 않는다. 그 폴더 밖의 파일이 필요하면 사용자에게 폴더를 옮겨 달라고
  요청하거나, 읽기라면 허용된 명령(`tail`, `cat`)으로 내용을 받는다.

- `terminalEnabled`는 사용자가 이 서버의 **출력 표시**를 켜 두었다는 뜻이다. 그 서버에서는
  `ssh`를 직접 부르지 않고 아래 "출력 표시가 켜진 서버는 앱을 거쳐 실행" 절차로 실행한다.

## 명령 정책을 먼저 읽는다

각 항목의 `allowedCommands`·`deniedCommands`는 사용자가 이 서버에 대해 정한 규칙이다.
**요청받은 작업이 규칙 밖이면 실행하지 말고 사용자에게 먼저 확인한다.**

- 규칙은 원격에서 실행할 명령의 **앞머리**와 맞춰 본다. `systemctl status`는
  `systemctl status app`에 걸리고, `cat`은 `cat /var/log/app.log`에 걸린다.
- 파이프라인은 **단계마다** 따로 맞춰 본다. `journalctl -u app | grep -i error`는
  `journalctl`과 `grep`이 **둘 다** 규칙을 지나야 쓸 수 있다.
- **차단이 우선한다.** `cat`이 허용돼 있어도 `deniedCommands`의 `cat /etc/shadow`에 걸리는
  명령은 실행하지 않는다.
- `commandPolicyMode`가 `allowlist`면 **허용 목록에 걸리는 명령만** 쓴다. `denylistOnly`면
  (허용 목록이 비어 있는 경우다) 차단 목록에 걸리지 않는 명령을 쓸 수 있다.
- `commandPolicyMode`가 `unrestricted`면(= `unrestrictedCommands`가 true) 사용자가 그 서버에
  대해 **무제한 명령 허용**을 켜 둔 것이다. 허용 목록은 보지 않고, 차단 목록에 걸리지 않는
  명령이면 사용자에게 먼저 확인하지 않고 실행해도 된다. 그래도 되돌리기 어려운 조작
  (데이터 삭제, 서비스 중단)은 작업의 목적에 맞는지 스스로 판단하고, 아래 셸·인터프리터·
  네트워크 페치 규칙은 이 모드에서도 그대로 지킨다.
- 규칙을 우회하려고 명령을 바꿔 쓰지 않는다 — `bash -c`로 감싸기, 별칭·심볼릭 링크,
  `find -exec`, 스크립트 파일로 옮겨 실행하기 모두 우회다. 필요하면 사용자에게 설정
  → 플러그인 → SSH → 연결 서버 → 고급 설정에서 목록을 고쳐 달라고 요청한다.
- 이 목록은 Agent Manager가 서버에서 강제하는 것이 아니라 **너에게 준 지시**다. 지키는
  주체는 너다. (셸이 없는 AIA는 앱의 실행 작업으로 접속하고 그 경로에서는 백엔드가 같은
  목록을 실제로 집행한다. 너처럼 자기 셸로 붙는 경로에서는 집행 지점이 없다. AIA 경로는
  목록 밖 명령을 사용자에게 1회 승인받아 실행할 수 있지만, 그 승인 카드를 띄우는 자리는
  앱의 실행 작업뿐이라 이 경로에는 없다 — 목록 밖 작업이 필요하면 사용자에게 요청한다.)
- 셸을 새로 여는 명령(`sh -c`, `bash`, `env`, `eval`)과 네트워크에서 코드를 끌어오는 명령
  (`curl`, `wget`)은 허용 목록에 적혀 있어도, **파이프라인의 중간 단계여도** 쓰지 않는다.
  `… | xargs rm`, `… | awk 'system(…)'`도 같은 이유로 쓰지 않는다. 그 한 줄이 나머지 규칙
  전부를 무의미하게 만든다. 설치·해제가 필요하면 그 작업을 하는 명령(`tar -xzf`, 패키지 관리자)이
  허용 목록에 있는지 확인하고, 없으면 사용자에게 요청한다.

## 출력 표시가 켜진 서버는 앱을 거쳐 실행

`terminalEnabled`가 true인 서버에서는 **`ssh`를 직접 부르지 않는다.** 대신 `relayArgs` 뒤에
원격 명령 단어들을 붙여 같은 실행 파일로 부른다.

```sh
"$CLI" $CLI_PREFIX ssh exec --fingerprint 'SHA256:…' -- systemctl status app --no-pager
"$CLI" $CLI_PREFIX ssh exec --fingerprint 'SHA256:…' --timeout 120 -- tail -n 200 /var/log/app.log
# 파이프·인용이 들어가면 명령 전체를 큰따옴표로 감싸 **한 덩이로** 넘긴다. 그러지 않으면
# 파이프를 네 셸이 먼저 먹어 CLI의 출력이 로컬 grep으로 들어간다.
"$CLI" $CLI_PREFIX ssh exec --fingerprint 'SHA256:…' -- "journalctl -u app -n 200 | grep -i error"
"$CLI" $CLI_PREFIX ssh exec --fingerprint 'SHA256:…' -- "grep -c 'foo bar' /var/log/app.log"
```

- 실행은 떠 있는 Agent Manager 백엔드가 하고, 출력은 **사용자가 보는 이 대화의 도구 카드에
  실시간으로 흐른다.** 너에게는 끝난 뒤 JSON 영수증(`succeeded`, `timedOut`, `stdout`,
  `stderr`, `message`)이 stdout으로 온다. 실패하면 종료 코드도 1이다.
- 이 경로에서는 허용·차단 명령 목록을 **백엔드가 실제로 집행한다.** 목록 밖 명령은 승인
  카드 없이 거절되므로, 필요하면 사용자에게 애드온 → SSH → 연결 서버 → 고급
  설정에서 목록을 고쳐 달라고 요청한다. `--` 뒤 단어들은 한 칸씩 이어 붙인 뒤 **백엔드가
  다시 파싱한다**: 파이프(`|`)·리다이렉션(`>` `>>` `<` `2>&1`)·인용·글롭은 쓸 수 있고
  단계마다 목록이 대조되므로 **모든 단계가** 허용 목록에 걸려야 한다. 명령을 잇거나 새로
  만드는 문법(`;` `&&` `||` `&` `$(…)` 백틱 `$VAR` `\` `{}` `()`)은 거절되니 여러 단계는
  단계마다 따로 부른다. 파일로 내보내는 `>`·`>>`는 무제한 명령 허용을 켠 서버에서만 열린다.
- `--timeout`은 초 단위로 기본 60, 최대 300이다. 끝나지 않는 명령(`tail -f`)은 그 시간에
  끊긴다.
- 백엔드에 연결하지 못했다는 오류가 오면 Agent Manager가 실행 중이 아닌 것이다. `ssh`를
  직접 부르는 것으로 우회하지 말고 사용자에게 앱을 실행해 달라고 말한다.
- `AGENT_MANAGER_CHAT_ID` 환경 변수는 Agent Manager가 이 대화의 셸에 심어 둔 값이다. 지우거나
  바꾸지 않는다 — 없으면 출력이 화면에 흐르지 않고 실행만 된다.
- 파일 전송은 이 경로에 없다. 아래 `scp` 절 그대로 한다.

## 접속

`terminalEnabled`가 false인 서버에서는 `sshCommand`를 그대로 쓰거나 `sshArgs` 뒤에 원격
명령을 붙인다.

```sh
ssh -i /Users/me/.ssh/id_deploy -p 22 -o IdentitiesOnly=yes -o BatchMode=yes \
  deploy@build.example.com 'systemctl status app --no-pager'
```

- **인자를 바꾸지 않는다.** `IdentitiesOnly=yes`는 목록이 지정한 키만 쓰게 하고,
  `BatchMode=yes`는 암호 프롬프트에서 무한정 멈추지 않게 한다. 특히
  `StrictHostKeyChecking=no`나 `-o UserKnownHostsFile=/dev/null`을 덧붙여 호스트 키 확인을
  끄지 않는다.
- `Host key verification failed`가 나오면 그 호스트 키가 아직 `known_hosts`에 없는 것이다.
  우회하지 말고, 사용자에게 터미널에서 한 번 접속해 호스트 키를 확인해 달라고 요청한다.
- `Permission denied (publickey)`면 서버의 `authorized_keys`에 이 키가 없는 것이다. 다른
  키로 바꿔 가며 시도하지 말고 사용자에게 알린다. 공개키 본문은 애드온 → SSH의
  "공개키 확인"에서 볼 수 있다.
- 오래 걸리는 명령은 `-o ConnectTimeout=10`을 함께 주고, 결과를 기다릴 수 없으면 원격에서
  로그로 남기고 나중에 읽는다.

## 파일 올리고 받기

`fileTransferEnabled`가 켜진 서버에만 올린다. 접속과 같은 인자를 쓰고 포트 플래그만 다르다
(`scp`는 `-P`).

```sh
scp -i /Users/me/.ssh/id_deploy -P 22 -o IdentitiesOnly=yes -o BatchMode=yes \
  ./dist/app.tgz deploy@build.example.com:/srv/releases/app.tgz
```

- 대상은 항상 `transferRoot` 아래다. 그 폴더 밖으로 올리라는 요청은 사용자에게 되묻는다.
- 올린 뒤 양쪽 SHA-256을 맞춰 본다 — 로컬은 `shasum -a 256`, 원격은 `sha256sum`(없으면
  `shasum -a 256`)이다. 다르면 배포를 이어가지 말고 사용자에게 알린다.
- 이미 있는 파일을 말없이 덮지 않는다. 먼저 원격 지문을 읽어 무엇이 있는지 확인하고,
  덮어써야 하면 사용자에게 확인받는다.
- 올린 파일을 원격에서 실행·설치하는 것은 **전송이 아니라 명령**이다. 그 명령이 허용 목록에
  있어야 하고, 없으면 사용자에게 요청한다.
- `~/.ssh`·공급자 홈(`~/.claude`, `~/.codex`)·Agent Manager 데이터 폴더의 파일과 `.aws`,
  `.gnupg`, `.netrc`처럼 자격증명이 놓이는 자리의 파일은 올리지 않는다.

받는 것은 방향만 반대이며 같은 권한·같은 폴더를 쓴다.

```sh
scp -i /Users/me/.ssh/id_deploy -P 22 -o IdentitiesOnly=yes -o BatchMode=yes \
  deploy@build.example.com:/srv/releases/logs/app.log ./inbox/app.log
```

- 받는 자리는 **이미 있는 폴더 아래**로 정한다. 폴더를 새로 만들어 받지 말고, 없으면
  사용자에게 어디에 받을지 묻는다.
- `~/.ssh`·공급자 홈·Agent Manager 데이터 폴더와 자격증명이 놓이는 자리에는 받지 않는다.
  올릴 수 없는 자리는 받아 쓸 수도 없는 자리다.
- 이미 있는 파일을 말없이 덮지 않는다. 사용자에게 확인받거나 다른 이름으로 받는다.
- 받은 뒤 지문을 맞춰 본다. 전송이 끊겨 반쪽만 남은 파일을 정상 결과로 다루지 않는다.

## 하지 않을 것

- 개인키 파일을 읽거나, 복사하거나, 내용을 출력하지 않는다. `ssh`에 경로만 넘긴다.
- 목록에 없는 호스트·사용자·키로 접속하지 않는다. 사용자 `~/.ssh/config`를 뒤져 다른
  대상을 찾지 않는다.
- `~/.ssh`의 어떤 파일도 고치지 않는다. 키 생성·삭제·메모·연결 서버 변경은 모두 Agent
  Manager 설정 화면의 일이다.
- 원격에서 되돌리기 어려운 명령(삭제, 서비스 중단, 배포)은 사용자에게 먼저 확인받는다.
  로컬에서와 같은 기준을 원격에서도 적용한다.
