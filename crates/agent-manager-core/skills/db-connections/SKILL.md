---
name: db-connections
description: Agent Manager 애드온에서 "에이전트 사용"을 켜 둔 데이터베이스 연결로 조회하고, 승인을 받아 변경한다. "DB 조회해줘", "테이블 확인", "데이터 몇 건인지 봐줘", "기준데이터 넣어줘", "개발DB에서 확인" 같은 요청이나, 어느 계정·어느 스키마로 붙어야 하는지 모를 때 사용한다. 로컬 파일만 다루면 쓰지 않는다.
---

# 허용된 데이터베이스 연결 사용하기

사용자가 Agent Manager의 애드온 → 데이터베이스에서 연결을 등록하고 **에이전트 사용**을
켜 둔 것만 이 목록에 나온다. 목록에 없는 데이터베이스에는 접속하지 않는다.

**비밀번호는 이 경로로 넘어오지 않는다.** SSH와 다른 점이다 — `ssh`는 키 경로만 받으면
에이전트가 직접 붙을 수 있지만, 데이터베이스는 비밀번호가 있어야 붙으므로 **접속과 실행을
앱이 대신한다.** 그래서 `mysql`·`psql`을 직접 부르지 말고 아래 명령만 쓴다. 사용자의
`~/.my.cnf`·`~/.mylogin.cnf`를 뒤져 직접 붙는 것도 하지 않는다.

## 실행 파일 찾기

```sh
eval "$(python3 -c 'import json,os,shlex
p=os.path.expanduser("~/Library/Application Support/com.shinc.agentmanager/session-read-cli-v1.json")
d=json.load(open(p))
print("CLI=" + shlex.quote(d["executable"]))
print("CLI_PREFIX=" + shlex.quote(" ".join(d.get("argvPrefix", []))))')"
```

이후 호출은 항상 `"$CLI" $CLI_PREFIX db ...` 형태로 쓴다. 파일이 없으면 Agent Manager
백엔드가 한 번도 실행되지 않은 것이다. 그때는 사용자에게 앱을 실행해 달라고 말한다.

## 목록 받기

```sh
"$CLI" $CLI_PREFIX db list
```

```json
{
  "schemaVersion": 1,
  "connections": [
    {
      "id": "kbf-dev",
      "displayName": "KBF 개발",
      "engine": "mariadb",
      "environment": "dev",
      "destination": "uhrms@172.28.41.163:43306/uhrmsdb",
      "database": "uhrmsdb",
      "writeMode": "dmlWithApproval",
      "schemaScope": ["TB_", "APRV"],
      "maskedColumns": ["RESID_NO"],
      "maxRows": 200,
      "note": "사내망에서만 도달"
    }
  ],
  "skipped": [{"id": "…", "reason": "…"}],
  "issues": []
}
```

- `connections`가 비어 있으면 **쓸 수 있는 연결이 없는 것이다.** 다른 접속 방법을 찾지 말고
  사용자에게 애드온 → 데이터베이스에서 연결을 등록하고 "에이전트 사용"을 켜 달라고 말한다.
- `skipped`는 켜 두었지만 지금 쓸 수 없는 항목이다(비밀번호 미저장, 자격증명 파일 없음).
  이유를 그대로 사용자에게 전한다.
- `environment`가 `production`이면 **변경은 아예 실행되지 않는다.** 조회만 한다.

## 조회

```sh
"$CLI" $CLI_PREFIX db query --connection kbf-dev --sql "SELECT MENU_ID, MENU_NM FROM TB_MENU_BAS WHERE CO_ID = 'KBF'" --max-rows 50
```

- **한 번에 한 문장만** 받는다. 세미콜론으로 이어 붙이면 거절된다 — 단계마다 따로 부른다.
- 조회는 엔진 수준 읽기 전용 트랜잭션 안에서 돈다. 쓰기 문장을 이 명령으로 보내면 거절된다.
- 결과의 `rows`는 모두 문자열이거나 `null`이다. `truncated`가 `true`면 상한에서 잘린
  것이므로 조건을 좁히거나 `--max-rows`를 올린다(연결의 상한을 넘지는 못한다).
- `maskedColumns`에 걸린 컬럼 값은 `●●●●`로 온다. **다른 질의로 우회해 꺼내지 않는다.**
- `schemaScope`가 정해진 연결에서 그 밖의 테이블을 참조하면 거절된다.

## 변경 — 승인을 두 번에 나눠 받는다

```sh
# 1차: 아무것도 커밋되지 않는다. 예행으로 영향 행 수만 센다.
"$CLI" $CLI_PREFIX db exec --connection kbf-dev --sql "UPDATE TB_MENU_BAS SET MENU_NM = '요청서' WHERE CO_ID = 'KBF' AND MENU_ID = '222'"
```

응답에 `approvalRequired: true`와 `approvalId`·`expiresAt`·`previewedRows`가 온다.
종료 코드는 `2`다(실패가 아니라 **대기**라는 뜻이다).

그다음 사용자에게 **대상(`destination`)·환경·정확한 SQL·예상 행 수**를 그대로 전하고
화면의 승인 카드에서 허용해 달라고 요청한다. 허용됐다는 안내를 받으면:

```sh
# 2차: 같은 approvalId와 글자 하나까지 같은 SQL로 한 번 더 부른다.
"$CLI" $CLI_PREFIX db exec --connection kbf-dev --approval-id "db-approval-…" --sql "UPDATE TB_MENU_BAS SET MENU_NM = '요청서' WHERE CO_ID = 'KBF' AND MENU_ID = '222'"
```

- 승인은 **이 대화·이 연결·이 문장 1회용**이다. 문장을 한 글자라도 바꾸거나 다른 연결에
  쓰거나 두 번 쓰면 무효다. 그때는 다시 승인을 받는다.
- 승인 카드는 사용자만 누른다. 대신 눌러 주지 않고, 승인됐다고 가정하지 않는다.
- 구조 변경(`CREATE`·`ALTER`)은 엔진이 암시적 커밋을 하므로 **예행이 없고 되돌릴 수 없다.**
  승인 카드에 그 사실이 적히며, 연결의 쓰기 모드가 `ddlWithApproval`이어야 한다.
- 쓰기 모드가 허용하지 않는 문장은 승인 이전에 거절된다. 그때는 사용자에게 애드온 →
  데이터베이스에서 그 연결의 쓰기 모드를 올려 달라고 요청한다.

## 어떤 경우에도 실행되지 않는 것

`DROP`·`TRUNCATE`·`GRANT`·`REVOKE`·`SET`·`USE`·`CALL`·`EXECUTE`·`LOAD`·`COPY`·`PRAGMA`·
`ATTACH`·`VACUUM`과 트랜잭션 제어(`BEGIN`·`COMMIT`·`ROLLBACK`), 그리고 파일·셸에 닿는
함수(`INTO OUTFILE`, `LOAD_FILE`, `pg_read_file`, `xp_cmdshell` 등)는 쓰기 모드나 승인과
무관하게 거절된다. **규칙을 우회하려고 문장을 바꿔 쓰지 않는다.** 그 작업이 정말 필요하면
사용자에게 무엇이 왜 필요한지 말하고 사용자가 직접 하도록 한다.

여기서 막는 것은 이 앱의 실행 경로다. 서버에서 강제되는 권한 제한이 아니므로, 목록과
상한이 있다고 해서 그 계정이 할 수 있는 일이 줄어든 것은 아니다.
