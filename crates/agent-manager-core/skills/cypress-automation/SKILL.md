---
name: cypress-automation
description: Agent Manager에 등록된 Cypress 작업공간에서 모든 에이전트의 브라우저 자동화를 수행한다. 테스트·조회·크롤링·매크로에 사용한다.
---

# Cypress 전용 연결

애드온 → Cypress에서 사용자가 켠 작업공간만 사용한다.
Claude·Codex 일반 채팅은 agent_manager_Cypress MCP를 우선 사용한다. AIA는 aia_system의 동명 작업을 사용한다.
Antigravity 등 직접 MCP 연결이 없는 공급자는 아래 방식으로 **같은 Cypress 전용 MCP**에 요청한다. 권한 없이 직접 Cypress CLI로 우회하지 않는다.

## MCP 연결이 없는 공급자

채팅 시작 지침이 알려 준 cypress-agent-mcp.json 경로에서 url을 읽는다. 이 파일은 실행 중 백엔드가 생성한다. 경로·포트를 추측하지 않는다.
Python 표준 라이브러리로 HTTP JSON-RPC POST를 보낸다. URL은 http://127.0.0.1 이고 query/userinfo가 없는지 검사한다. 프록시 및 리다이렉트는 사용하지 않는다.
아래 POINTER에는 시작 지침의 실제 연결 파일 경로를 넣고 PAYLOAD에는 요청 객체를 넣는다. 계정 값은 어느 쪽에도 넣지 않는다.

```python
import json, urllib.request, urllib.parse
from pathlib import Path
url = json.loads(Path(POINTER).read_text())["url"]
p = urllib.parse.urlsplit(url)
assert p.scheme == "http" and p.hostname == "127.0.0.1" and not p.username and not p.password and not p.query and not p.fragment
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
request = urllib.request.Request(url, data=json.dumps(PAYLOAD).encode(), headers={"Content-Type":"application/json"})
with opener.open(request, timeout=180) as response:
    print(response.read(1024 * 1024).decode())
```

먼저 {"jsonrpc":"2.0","id":1,"method":"tools/list"}를 호출해 현재 도구 계약을 읽는다.
호출은 {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_cypress_workspaces","arguments":{}}} 형태이다.
연결 실패나 빈 tools 목록이면 실행하지 말고 설정의 사용 여부와 백엔드 실행 상태를 안내한다.

## 실행

1. list_cypress_workspaces → 현재 요청의 프로젝트 path와 executionType이 정확히 맞는 작업공간을 명시적으로 선택하고 moduleReady 확인. 기본 작업공간이나 첫 항목을 자동 선택하지 않는다. Agent Manager 자체 QA는 agentManagerIsolated, 다른 사이트·프로젝트는 standard를 사용한다. 필요하면 사용자 요청 범위 내 add_cypress_workspace/install_cypress_module 사용.
2. list_cypress_workspace_files/read_cypress_workspace_file로 기존 설정과 마스킹된 환경변수 키 확인.
3. write_cypress_workspace_file로 e2e/ 아래 *.cy.js 작성. 비밀번호는 Cypress.env("키")로만 참조, 입력 log:false. 사용자 요청 사이트·동작에 한정.
4. run_cypress_spec으로 해당 스펙만 실행하고 jobId 저장.
5. get_cypress_run_status로 끝날 때까지 조회. cy.saveResult로 저장한 artifacts 실제 내용으로 판정.

사용 토글·등록 해제·환경변수 원문 읽기/쓰기는 에이전트 도구에 없다. 환경변수 값이나 쿠키·토큰을 문서·로그·스크린샷에 노출하지 않는다.
도구 결과의 isError와 Cypress 상태를 확인하고 요청 접수만으로 QA 완료라고 말하지 않는다. 사이트의 실제 결함과 실행환경 차단을 구분한다.
