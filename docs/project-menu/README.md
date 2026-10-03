# 프로젝트 메뉴 고도화 — 수용 점검표와 측정 탐침

노션 계획 [프로젝트 메뉴 고도화 및 브랜치 독립 로컬 설정 Overlay](https://app.notion.com/p/8c2257f3dd7282f5a6d2815817481b4a)의
구현 단계와 완료 기준을, **제품이 실제로 읽는 계약 위에서** 다시 묻는 점검표다.
무인 회차(`project-menu-overlay-round` 스킬)가 회차마다 이것으로 재고, 한 항목을 고치고, 다시 잰다.

왜 점검표인가. 에이전트가 "구현했습니다"라고 적은 것은 증거가 아니다. 커맨드를 Core에 만들고
화면에 버튼만 달아 놓으면 동작하는 것처럼 보이지만, `remote.rs`의 쓰기 게이트에 올리지 않았으면
원격 UI에서 조용히 통과하고, `system_mcp.rs`에 등록하지 않았으면 AIA가 그 기능을 영영 못 본다.
그 네 자리를 사람이 매번 기억해서 보는 대신 점검표가 본다.

## 돌리는 법

```sh
node --experimental-strip-types scripts/project-menu-conformance.mjs                  # 표
node --experimental-strip-types scripts/project-menu-conformance.mjs --json           # 기계용
node --experimental-strip-types scripts/project-menu-conformance.mjs --write-baseline # 기준선 갱신
npm run conformance:project-menu
```

종료 코드는 **회귀나 안전규칙위반이 있을 때만 1**이다. 미구현은 아직 안 한 일이지 고장이 아니므로 0이다.

## 파일

| 파일 | 무엇 |
| --- | --- |
| `acceptance.json` | 점검표. 항목 하나가 계획의 수용 기준 하나다 |
| `baseline.json` | 직전 회차의 점검별 통과 여부. 회귀를 세는 근거. 회차가 반영한 뒤에만 갱신한다 |
| `../../src/lib/projectMenuConformance.ts` | 맞추기 규칙과 실패 종류 분류(순수 함수) |
| `../../src/lib/projectMenuConformance.test.mjs` | 그 규칙의 단위 시험 |
| `../../scripts/project-menu-conformance.mjs` | 파일을 읽어 점검표를 돌리는 러너 |

## 판정은 합격률이 아니라 실패 종류다

| 종류 | 뜻 |
| --- | --- |
| `회귀` | 직전 기준선에서 통과하던 점검이 깨졌다. 가장 먼저 센다 |
| `안전규칙위반` | 구현은 있는데 가드가 없거나, 되돌릴 수 없는 git 명령이 들어왔다 |
| `미구현` | 아직 만들지 않았다. 파일이 없어서 깨진 가드 점검도 여기다 |
| `계약누락` | 만들었는데 디스패치·쓰기 게이트·AIA 카탈로그·IPC·AGENTS 예외 중 하나가 빠졌다 |
| `검증없음` | 만들었고 계약도 올렸는데 회귀 시험이 없다 |

한 항목은 가장 앞선 종류 **하나**로만 센다. 합격률(`항목 n/m`)은 참고 수치로만 적는다.

## 점검 종류

`acceptance.json`의 `kind`가 무엇을 읽는지.

| kind | 읽는 곳 | 통과 조건 |
| --- | --- | --- |
| `rustSymbol` | 지정한 `.rs` | `fn`/`struct`/`enum`/`const` **선언**이 있다. 호출만 있는 것은 통과가 아니다 |
| `frontendSymbol` | 지정한 `.ts`/`.tsx` | 이름이 나온다 |
| `remoteDispatch` | `remote.rs` | `"<명령>" =>` 갈래가 있다 |
| `remoteWriteGate` | `remote.rs` | `is_write_command` 블록 안에 있다(`expect: false`면 없어야 한다) |
| `remoteHostOnly` | `remote.rs` | `is_host_only_command` 블록 안에 있다 |
| `aiaCapability` | `system_mcp.rs` | `capability!(<등급>, "<명령>"` 로 등록돼 있다 |
| `ipcWrapper` | `src/lib/ipcProjects.ts` | 명령 이름이 나온다 |
| `agentsRule` | `AGENTS.md` | `### <ID> —` 절이 있다 |
| `testNamed` | 지정한 파일 | `.rs`면 `fn <이름>(`, 그 밖이면 이름 문자열이 있다 |
| `requiredLiterals` | 지정한 파일(들) | 적은 문자열이 전부 있다 |
| `forbiddenLiterals` | 지정한 파일(들) | 적은 문자열이 하나도 없다 |

`category`를 적으면 기본 갈래를 덮어쓴다. 가드로 세고 싶은 `requiredLiterals`에 `"category": "safety"`를
붙이는 식이다. 파일 자체가 없어서 깨진 점검은 갈래와 무관하게 **미구현**으로 센다 — 아직 만들지
않은 것은 가드를 어긴 것이 아니다.

## 점검표를 고칠 때

`acceptance.json`에 적힌 **이름은 회차가 구현할 계약이다.** 다른 이름으로 구현했으면 점검표를
먼저 고치고, 왜 바꿨는지 회차 보고(`record_round_report`)에 적는다. 조용히 점검을 지워 통과시키는
것은 측정이 아니다.

항목이 20개 미만이면 러너가 거절한다(종료 코드 2). 한 항목을 고치고 "좋아졌다"고 적지 않도록
판정 표본을 넓게 유지하기 위한 것이다.
