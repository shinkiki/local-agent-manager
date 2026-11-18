---
name: k8s-clusters
description: Agent Manager 애드온에서 "에이전트 사용"을 켜 둔 Kubernetes 클러스터(k3s·GKE·OKE 등)의 상태·파드·로그·이벤트를 읽는다. "파드 상태 봐줘", "배포 잘 됐는지 확인", "왜 재시작하는지 로그 봐줘", "클러스터 노드 확인", "k3s에서 확인" 같은 요청이나, 어느 kubeconfig로 붙어야 하는지 모를 때 사용한다. 로컬 도커만 다루면 쓰지 않는다.
---

# 허용된 Kubernetes 클러스터 읽기

사용자가 Agent Manager의 애드온 → Kubernetes에서 클러스터를 등록하고 **에이전트 사용**을
켜 둔 것만 이 목록에 나온다. 목록에 없는 클러스터에는 접속하지 않는다.

**kubeconfig·토큰은 이 경로로 넘어오지 않는다.** 접속과 API 호출은 앱이 대신하므로
`kubectl`·`helm`을 직접 부르지 말고 아래 명령만 쓴다. `~/.kube/config`나 다른 곳의
kubeconfig를 찾아 직접 붙는 것도 하지 않는다.

## 실행 파일 찾기

```sh
eval "$(python3 -c 'import json,os,shlex,sys
e=os.environ.get("AGENT_MANAGER_APP_DATA_DIR","")
h=os.path.expanduser("~")
x=os.environ.get("XDG_DATA_HOME","")
c=[e] if os.path.isabs(e) else [os.path.join(h,"Library/Application Support/com.shinc.agentmanager"),
   os.path.join(os.environ.get("APPDATA") or os.path.join(h,"AppData/Roaming"),"com.shinc.agentmanager"),
   os.path.join(x if os.path.isabs(x) else os.path.join(h,".local/share"),"com.shinc.agentmanager")]
p=next((f for f in (os.path.join(d,"session-read-cli-v1.json") for d in c) if os.path.isfile(f)),None)
if not p: sys.exit("Agent Manager 백엔드 위치 파일이 없습니다: " + ", ".join(c))
d=json.load(open(p,encoding="utf-8"))
print("CLI=" + shlex.quote(d["executable"]))
print("CLI_PREFIX=" + shlex.quote(" ".join(d.get("argvPrefix", []))))')"
```

`AGENT_MANAGER_APP_DATA_DIR`는 이 대화를 띄운 백엔드가 셸에 심어 둔 **자기 앱 데이터 폴더**다.
헤드리스 서버처럼 백엔드가 플랫폼 기본 폴더가 아닌 곳(`--app-data-dir <경로>`)으로 떠 있어도 이 값이 그
자리를 가리키고, CLI도 같은 값을 읽으므로 `--app-data-dir`를 따로 붙이지 않는다. 지우거나
바꾸지 않는다. 값이 없는 셸(사용자가 직접 연 터미널)에서만 플랫폼 기본 폴더를 본다.

이후 호출은 항상 `"$CLI" $CLI_PREFIX k8s ...` 형태로 쓴다. 파일이 없으면 오류에 살펴본
폴더가 나온다. 그 폴더를 함께 알리고 사용자에게 앱이 떠 있는지 확인해 달라고 말한다.

## 목록 받기

```sh
"$CLI" $CLI_PREFIX k8s list
```

```json
{
  "schemaVersion": 1,
  "clusters": [
    {
      "id": "oci-k3s",
      "displayName": "OCI k3s",
      "environment": "production",
      "server": "https://100.101.102.103:6443",
      "namespaces": ["qa-lite", "money-note"],
      "note": ""
    }
  ],
  "skipped": [{"id": "…", "reason": "…"}],
  "issues": []
}
```

- `clusters`가 비어 있으면 **쓸 수 있는 클러스터가 없는 것이다.** 다른 접속 방법을 찾지 말고
  사용자에게 애드온 → Kubernetes에서 클러스터를 등록하고 에이전트 사용을 켜 달라고 말한다.
- `namespaces`가 있으면 그 네임스페이스만 읽을 수 있고, 네임스페이스 소속 종류에는
  `--namespace`를 꼭 준다. 비어 있으면 제한이 없다. Node처럼 클러스터 소속 종류는 범위와 무관하다.

## 읽기 명령

| 하고 싶은 일 | 명령 |
| --- | --- |
| 연결·버전·노드·내 권한 | `k8s check --cluster <id>` |
| 목록 | `k8s resources --cluster <id> --kind pods [-n <ns>] [-l app=x] [--field-selector …] [--limit 100]` |
| 객체 하나 | `k8s get --cluster <id> --kind deployment -n <ns> --name <이름> [--api-version apps/v1]` |
| 파드 로그 | `k8s logs --cluster <id> -n <ns> --name <파드> [-c <컨테이너>] [--tail 200] [--since 600] [--previous]` |
| 이벤트 | `k8s events --cluster <id> [-n <ns>] [--name <대상>] [--kind Pod] [--warnings]` |

모든 호출 앞에 `"$CLI" $CLI_PREFIX`를 붙인다. 결과는 JSON이다.

- `--kind`는 `pods`·`po`·`deploy`·`svc`·`sts`·`ing` 같은 kubectl 별칭을 받는다. 표에 없는
  종류(Traefik `IngressRoute` 같은 CRD)는 클러스터에서 찾아보며, `--api-version`을 주면 빠르다.
- `resources`는 종류별 요약 행만 준다(파드: phase·ready·restarts·waiting·node, Deployment:
  replicas·ready·images 등). 전체 객체가 필요할 때만 `get`을 쓴다.
- 파드가 재시작을 반복하면 `events --name <파드> --warnings` → `logs --previous` 순서로 본다.

## 가려지는 것

- Secret의 값은 `<가려짐: N바이트>`로 오고, 목록에는 키 이름만 나온다.
- `last-applied-configuration` 주석과 `managedFields`는 빠진다.
- 이름에 PASSWORD·SECRET·TOKEN 등이 들어간 env 항목의 `value`는 가려진다.
- 로그·이벤트의 40자 넘는 토큰꼴 값과 키 블록은 지워진다.

가린 값을 다른 명령이나 다른 경로로 꺼내려 하지 않는다.

## 할 수 없는 것

이 경로는 **읽기만** 한다. 배포·이미지 교체·재시작·스케일·삭제·`exec`·`port-forward`는
없다. 바꿔야 하면 무엇을 어떻게 바꿀지 정리해 사용자에게 알린다. 사용자가 허락한 SSH
서버에서 `kubectl`로 하라고 하면 그 경로(ssh-endpoints 스킬)를 쓴다.

실제 권한은 클러스터의 RBAC가 정한다. `check` 결과의 `broadAccess`가 `true`면 이 계정이
모든 리소스를 바꿀 수 있다는 뜻이니, 사용자에게 네임스페이스로 좁힌 ServiceAccount를 권한다.
