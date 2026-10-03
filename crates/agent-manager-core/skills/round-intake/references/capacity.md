# 동시 건수를 예산에서 읽는 법

`get_usage_budget` 한 번이면 "이 회차를 동시 몇 건까지 돌릴 수 있는가"의 답이 나온다.
물어보기 전에 이 숫자를 손에 쥔다.

## 어디를 보는가

`consumers[]` 에서 이 회차의 `workflowId` 를 찾고 그 안의 `throughput.rounds[]` 를 읽는다.

| 필드 | 뜻 |
|---|---|
| `maxRuns` | 지금 예산으로 한 회차에 띄울 수 있는 건수 |
| `recommendedMaxRuns` | 목표에 도달하려면 올려야 하는 건수 (null 이면 지금으로 충분) |
| `supplyPercentPerHour` | 참여 계정이 시간당 내줄 수 있는 사용률 |
| `demandPercentPerHour` | 이 주기로 돌 때 시간당 먹는 사용률 |
| `reachesTarget` | 공급이 수요를 덮는가 |
| `costPercentPerRun` | 실측 회차당 비용 |

새 회차라 `consumers[]` 에 아직 없으면 비슷한 회차의 `costPercentPerRun` 을 빌려 어림한다.
그것도 없으면 **재지 못했다고 말하고** 건수를 묻는다 — 지어내지 않는다.

## 추천치를 고르는 규칙

- `reachesTarget` 이 false 이고 `recommendedMaxRuns` 가 있으면 그 값을 추천한다.
- true 면 `maxRuns` 가 상한이다. 그보다 크게 적어도 실제로는 계정 여력과 가드 창이 자른다.
- `maxRuns` 가 1이면 병렬이 아니다. 끄는 쪽을 추천하고 왜인지(공급이 모자람) 함께 말한다.
- 같은 워크트리를 여러 런타임이 만지는 작업이면 숫자와 무관하게 끈다. 레인으로 갈라야 켤 수 있다.

## 계정 풀

`accounts[]` 에서 `inPool: true` 이고 `disabled: false` 인 것이 회차에 참여한다.
`overview.netHeadroomPercent` 가 그 계정의 남은 여력이다. 풀이 비어 있거나(`poolConfigured: false`)
페이싱이 꺼져 있으면 병렬 질문 자체가 의미 없다 — 그 사실을 말하고 넘어간다.

사용자가 풀·목표·회차 설정을 직접 보려면 워크플로 → 워크플로 페이싱 탭
(`show_ui_guide` target `workflows.usage-budget`)이다. 이 값들은 AIA 가 대신 바꾸지 않는다.
