---
name: chat-secrets
description: 사용자의 API 키·토큰·비밀번호가 필요한 작업을 값을 보지 않고 처리한다. "이 API 키로 호출해줘", "토큰이 필요해", "로그인해서 확인해줘", "비밀번호 넣어야 하는데" 같은 요청이나, 명령이 인증 값을 요구하는데 값이 없을 때 사용한다. 값이 필요 없는 로컬 작업에는 쓰지 않는다.
---

# 비밀값을 이름으로 쓰기

Agent Manager는 사용자가 이 대화에 건넨 비밀값을 **백엔드 메모리에만** 들고 있다. 너는
값을 받지 못한다 — 이름만 받는다. 값이 필요한 명령은 앱에 맡기면 앱이 그 자식 프로세스의
환경변수에만 값을 넣고, 출력에서 값을 지운 뒤 돌려준다.

**사용자에게 채팅에 비밀값을 적어 달라고 하지 않는다.** 채팅에 적힌 값은 공급자 서버와
전사에 남는다. 대신 아래 `secret request`로 입력 카드를 띄운다. 사용자가 이미 채팅에 값을
적었으면 그 값을 되풀이하지 말고, 화면 아래 **비밀값** 패널에 등록해 달라고 안내한다.

## 실행 파일 찾기

```sh
eval "$(python3 -c 'import json,os,shlex,sys
c=[os.path.expanduser("~/Library/Application Support/com.shinc.agentmanager"),
   os.path.join(os.environ.get("APPDATA",""),"com.shinc.agentmanager"),
   os.path.expanduser("~/.local/share/com.shinc.agentmanager")]
p=next((os.path.join(d,"session-read-cli-v1.json") for d in c if os.path.exists(os.path.join(d,"session-read-cli-v1.json"))),None)
if not p: sys.exit("Agent Manager 백엔드 위치 파일이 없습니다")
d=json.load(open(p,encoding="utf-8"))
print("CLI=" + shlex.quote(d["executable"]))
print("CLI_PREFIX=" + shlex.quote(" ".join(d.get("argvPrefix", []))))')"
```

이후 호출은 항상 `"$CLI" $CLI_PREFIX secret ...` 형태로 쓴다. 파일이 없으면 Agent Manager
백엔드가 한 번도 실행되지 않은 것이니 사용자에게 앱을 실행해 달라고 말한다.

`AGENT_MANAGER_CHAT_ID` 환경 변수는 Agent Manager가 이 대화의 셸에 심어 둔 값이다. 지우거나
바꾸지 않는다 — 이 값이 없으면 어느 대화의 비밀값인지 알 수 없어 모든 작업이 거절된다.

## 들고 있는 비밀값 보기

```sh
"$CLI" $CLI_PREFIX secret list
```

```json
{
  "chatId": "…",
  "secrets": [
    {"name": "SERVICE_API_KEY", "purpose": "결제 API 조회", "expiresAt": 1760000000000, "source": "user"}
  ],
  "ttlSeconds": 3600
}
```

값은 어느 칸에도 없다. `source`가 `user`면 사용자가 패널에서 직접 등록한 것, `agent`면 네
요청 카드에 입력한 것이다. 쓰일 때마다 만료가 `ttlSeconds`만큼 연장되고, 대화가 끝나면
사라진다.

## 사용자에게 요청하기

```sh
"$CLI" $CLI_PREFIX secret request --name SERVICE_API_KEY --purpose "결제 API 조회에 쓸 키"
```

- `--name`은 환경변수로 쓰일 이름이다. 대문자로 시작하고 대문자·숫자·밑줄만 쓴다.
- `--purpose`는 사용자가 카드에서 읽을 한 줄이다. 무엇에, 어디로 보내는 데 쓰는지 적는다.
- 응답이 `{"status":"requested", …}`면 카드가 떴다. **사용자가 값을 넣고 허용할 때까지
  기다린다.** 등록되면 "[Agent Manager 승인 결과] 사용자가 비밀값 …을(를) 등록했습니다"
  안내가 대화에 온다. `{"status":"alreadyHeld"}`면 이미 있으니 바로 쓴다.
- 거절 안내가 오면 같은 값을 다시 요청하지 말고 다른 방법을 제안하거나 무엇을 원하는지 묻는다.
- 승인 카드는 사용자만 누른다. 대신 눌렀다고 가정하지 않는다.

## 값을 넣어 실행하기

값이 들어가는 자리는 두 가지다. 둘 다 앱이 채우고, 너는 이름만 적는다.

**인자·stdin 자리표시자** `{{secret:이름}}` — 값을 인자로 직접 받는 프로그램에 쓴다. 셸을
끼울 필요가 없다.

```sh
"$CLI" $CLI_PREFIX secret run -- \
  curl -sS -H 'Authorization: Bearer {{secret:SERVICE_API_KEY}}' https://api.example.com/v1/me
```

```sh
"$CLI" $CLI_PREFIX secret run --stdin '{{secret:GH_TOKEN}}' -- gh auth login --with-token
```

**환경변수** `--env ENV=NAME` — 환경변수를 읽는 프로그램에 쓴다.

```sh
"$CLI" $CLI_PREFIX secret run --env PGPASSWORD=DB_PASSWORD --timeout 60 -- \
  psql -h db.example.com -U app -d appdb -c 'select count(*) from orders'
```

- `--env ENV=NAME`은 "환경변수 `ENV`에 비밀값 `NAME`의 값을 넣어라"다. 여러 번 줄 수 있다.
  자리표시자와 `--env` 중 하나는 있어야 한다.
- `--` 뒤가 실행할 명령이다. **셸 문자열이 아니라 인자 배열**이므로 `$VAR` 확장은 일어나지
  않는다. 첫 원소는 PATH의 실행 파일 이름이거나 절대 경로다. 자리표시자는 두 번째 원소부터와
  `--stdin` 텍스트 안에서만 바뀐다.
- `--cwd DIR`은 절대 경로의 작업 폴더, `--timeout SEC`는 기본 120, 최대 900이다.
- 응답 `stdout`·`stderr`에서 이 대화의 비밀값이 정확히 일치하는 자리는 `[제거된 비밀값]`으로
  바뀐다. `success`가 false면 종료 코드도 1이다.
- 없는 이름을 쓰면 아무것도 실행하지 않고 거절된다. 먼저 `secret list`로 확인한다.

## 값이 파일 안에 있어야 할 때

`.env`·설정 파일·자격증명 파일처럼 값이 파일에 적혀 있어야 도는 도구가 있다. 그때는 파일
내용에 자리표시자를 적고 앱이 채워 쓰게 한다. 값을 직접 쓰지 않는다.

```sh
"$CLI" $CLI_PREFIX secret write --path /abs/project/.env --content-stdin <<'EOF'
API_KEY={{secret:SERVICE_API_KEY}}
DEBUG=0
EOF
```

```sh
"$CLI" $CLI_PREFIX secret write --path ~/.config/tool/config.json --overwrite \
  --content '{"token": "{{secret:TOOL_TOKEN}}"}'
```

- `--path`는 `~`를 펼친 절대 경로다. **상위 폴더가 이미 있어야 하고** 폴더를 만들어 주지
  않는다. 공급자 홈·Agent Manager 데이터 폴더·`.ssh`·`.aws` 같은 자격증명 자리는 거절된다.
- 이미 있는 파일은 `--overwrite` 없이 덮지 않는다. 심볼릭 링크·폴더 자리는 거절된다.
- 자리표시자가 하나도 없는 내용은 거절된다. 값이 안 들어가는 파일은 네 파일 도구로 쓴다.
- 파일은 소유자만 읽는 권한으로 놓이고, 응답에는 경로·바이트 수·채운 이름만 온다.
  **쓴 파일을 다시 읽어 값을 대화에 옮기지 않는다.** 그 파일이 네가 읽을 수 있는 자리에
  있는 것은 도구가 돌게 하려는 것이지 네가 값을 보라는 뜻이 아니다.

## 하지 않는 것

- 값을 `echo`·`printenv`·`env`로 찍거나, `secret write`로 쓴 파일을 `cat`하거나, base64 등으로
  인코딩해 꺼내는 명령을 돌리지 않는다. 정화는 정확 일치만 잡으며 **실수를 막는 장치이지 우회를 막는 장치가 아니다.**
  그 경계를 지키는 것은 너다.
- 값을 다른 대화·다른 도구·다른 서버로 옮기지 않는다. 사용자가 `purpose`에 적은 용도 밖으로
  쓰지 않는다.
- 백엔드에 연결하지 못했다는 오류가 오면 사용자에게 앱을 실행해 달라고 말한다. 값을 채팅으로
  받는 것으로 우회하지 않는다.
