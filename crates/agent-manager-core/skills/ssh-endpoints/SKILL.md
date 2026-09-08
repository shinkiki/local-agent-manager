---
name: ssh-endpoints
description: Agent Manager 설정에서 "에이전트 사용"을 켜 둔 SSH 인증키로 원격 서버에 접속해 작업한다. "서버에 접속해서", "원격 서버 로그 확인", "배포 서버에서 실행", "저 장비에 ssh로 붙어서" 같은 요청이나, 어떤 키·계정으로 접속해야 하는지 모를 때 사용한다. 로컬 작업만 필요할 때는 쓰지 않는다.
---

# 허용된 SSH 연결 서버로 접속하기

사용자가 Agent Manager 설정(설정 → 플러그인 → SSH)에서 인증키마다 연결 서버를 적고
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
      "deniedCommands": ["rm -rf", "reboot", "cat /etc/shadow"]
    }
  ],
  "skipped": [{"fingerprint": "SHA256:…", "reason": "…"}],
  "issues": []
}
```

- `endpoints`가 비어 있으면 **쓸 수 있는 서버가 없는 것이다.** 다른 키를 찾거나 `~/.ssh`를
  뒤지지 말고, 사용자에게 설정 → 플러그인 → SSH에서 연결 서버를 적고 "에이전트 사용"을
  켜 달라고 말한다.
- `skipped`는 사용자가 켜 두었지만 지금은 쓸 수 없는 항목이다(개인키 없음, 키 삭제됨).
  이유를 그대로 사용자에게 전한다.
- `note`는 사용자가 이 키에 적어 둔 메모다. 어느 서버인지 고를 때의 근거로 쓴다.

## 명령 정책을 먼저 읽는다

각 항목의 `allowedCommands`·`deniedCommands`는 사용자가 이 서버에 대해 정한 규칙이다.
**요청받은 작업이 규칙 밖이면 실행하지 말고 사용자에게 먼저 확인한다.**

- 규칙은 원격에서 실행할 명령의 **앞머리**와 맞춰 본다. `systemctl status`는
  `systemctl status app`에 걸리고, `cat`은 `cat /var/log/app.log`에 걸린다.
- **차단이 우선한다.** `cat`이 허용돼 있어도 `deniedCommands`의 `cat /etc/shadow`에 걸리는
  명령은 실행하지 않는다.
- `commandPolicyMode`가 `allowlist`면 **허용 목록에 걸리는 명령만** 쓴다. `denylistOnly`면
  (허용 목록이 비어 있는 경우다) 차단 목록에 걸리지 않는 명령을 쓸 수 있다.
- 규칙을 우회하려고 명령을 바꿔 쓰지 않는다 — `bash -c`로 감싸기, 별칭·심볼릭 링크,
  `find -exec`, 스크립트 파일로 옮겨 실행하기 모두 우회다. 필요하면 사용자에게 설정
  → 플러그인 → SSH → 연결 서버 → 고급 설정에서 목록을 고쳐 달라고 요청한다.
- 이 목록은 Agent Manager가 서버에서 강제하는 것이 아니라 **너에게 준 지시**다. 지키는
  주체는 너다.

## 접속

`sshCommand`를 그대로 쓰거나 `sshArgs` 뒤에 원격 명령을 붙인다.

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
  키로 바꿔 가며 시도하지 말고 사용자에게 알린다. 공개키 본문은 설정 → 플러그인 → SSH의
  "공개키 확인"에서 볼 수 있다.
- 오래 걸리는 명령은 `-o ConnectTimeout=10`을 함께 주고, 결과를 기다릴 수 없으면 원격에서
  로그로 남기고 나중에 읽는다.

## 하지 않을 것

- 개인키 파일을 읽거나, 복사하거나, 내용을 출력하지 않는다. `ssh`에 경로만 넘긴다.
- 목록에 없는 호스트·사용자·키로 접속하지 않는다. 사용자 `~/.ssh/config`를 뒤져 다른
  대상을 찾지 않는다.
- `~/.ssh`의 어떤 파일도 고치지 않는다. 키 생성·삭제·메모·연결 서버 변경은 모두 Agent
  Manager 설정 화면의 일이다.
- 원격에서 되돌리기 어려운 명령(삭제, 서비스 중단, 배포)은 사용자에게 먼저 확인받는다.
  로컬에서와 같은 기준을 원격에서도 적용한다.
