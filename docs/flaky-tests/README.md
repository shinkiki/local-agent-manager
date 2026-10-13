# 간헐 실패 시험 격리

전체 suite 를 병렬로 돌릴 때만 이따금 깨지는 시험을 **재현 → 좁히기 → 격리 → 재측정** 순으로
다루는 자리다. 측정 도구는 `npm run flaky:isolate`(= `scripts/flaky-isolate.mjs`), 판정 규칙은
`src/lib/flakyTestReport.ts` 에 있고 단위 시험(`src/lib/flakyTestReport.test.mjs`)으로 고정돼 있다.

## 지금 쫓고 있는 것

| | |
|---|---|
| 대상 | `usage_budget_policy::tests::the_completion_condition_switch_keeps_the_text_and_stops_applying_it` |
| 증상 | 전체 suite 병렬 실행에서 6회 중 2회 실패. 단독 실행은 6/6 통과 |
| 검증 명령 | `cargo test -q -p agent-manager-core --lib` (AGENTS.md 8절 V1·V2 2단) |
| 통과 기준 | 같은 명령 연속 10회에서 대상 시험이 한 번도 실패하지 않는다 |

### 2026-10-05 설계 때 실제로 본 것 (기준선이 아니다)

도구를 만들며 같은 명령을 4회 돌렸다. 기준선은 회차의 첫 일이므로 여기 숫자를 기준선으로
쓰지 않는다. 다만 설계가 기댄 사실 둘은 적어 둔다.

- 한 실행에서 **대상이 아닌 다른 시험**이 깨졌다 —
  `accounts::tests::admissibility_is_decided_before_candidates_are_looked_at` ("쿨다운 안").
  나머지 3회는 전건 통과. 즉 흔들리는 것은 대상 하나가 아니라 **suite 다.** 대상만 보고
  "고쳤다"로 적으면 안 되는 이유가 여기 있다.
- lib 시험은 2084건, 전건 1회가 약 17초다. 연속 10회는 3분 남짓이라 측정이 비싸지 않다.

## 2026-10-05 1회차 실측 (레인 L01 · test-threads 기본 · Windows)

전건 `cargo test -q -p agent-manager-core --lib` 를 **합계 40회** 돌렸다(기준선 10 · 확인 20 ·
재확인 10). 기준선만 `baseline.json` 으로 남는다 — `runs/` 는 gitignore 대상이라 측정한
기계에만 있다. 그래서 숫자를 여기 적는다.

- **대상은 40회 중 0회 실패했다.** 이 기계·이 부하에서는 재현되지 않았다. 회차 규칙대로
  **아무것도 고치지 않았다** — 재현하지 못한 결함을 짐작으로 손대면 다음에 또 깨지고,
  그때는 무엇이 원인이었는지 알 수 없다.
- 대신 20회 블록에서 **다른 시험 셋이 각각 1회씩** 깨졌다(3/20). 흔들리는 것은 대상 하나가
  아니라 suite 라는 설계 때의 관찰이 다시 확인됐다. 다음 회차가 이어받을 후보다.

| 깨진 시험 | 횟수 |
|---|---|
| `accounts::tests::a_claude_refresh_is_deferred_only_while_the_same_account_runtime_is_alive` | 1/20 |
| `project_git::tests::c16_auth_failure_against_a_real_remote_keeps_head_and_reports_auth_failed` | 1/20 |
| `usage_budget_policy::tests::a_consumer_completion_condition_and_sprint_follow_the_absent_null_reset_rules` | 1/20 |

마지막 줄은 대상과 **같은 모듈**이다. 대상 하나를 쫓기보다 `usage_budget_policy` 모듈이
공유하는 자리를 보는 편이 나을 수 있다는 단서다 — 다만 1/20 은 좁히기를 시작할 근거이지
원인이 아니다.

## 2026-10-05 2회차 실측 (레인 L01 · test-threads 기본 · Windows) — 재현했고, 원인은 제품 쪽이다

전건을 **30회** 더 돌렸다(10 + 20). 1회차가 40회 중 한 번도 보지 못한 대상이 여기서
**20회 블록의 11번째에 깨졌다** — `verdict: target-flaky`. 1회차의 "미재현"이 무죄가 아니라
그 횟수 안에 안 나왔다는 뜻이었다는 것(README 의 "음성은 약한 증거다")이 그대로 확인됐다.

| 블록 | 대상 실패 | 아무 시험이나 실패 |
|---|---|---|
| 10회 | 0/10 | 3/10 |
| 20회 | **1/20** | 6/20 |
| 2회차 합계 | 1/30 | 9/30 |

### 좁히기 — 깨진 시험이 다 다른데 진단은 하나다

2회차에서 깨진 9건은 서로 관계없는 여섯 모듈에 흩어져 있었다(`accounts`, `store`,
`usage_budget_policy`, `project_git`, `scheduler`, `backend_service_settings`). 모듈로는
공통점이 없는데 **진단 문자열은 같았다.** 20회 블록이 남긴 7건의 진단 중 다섯이 글자 그대로
한 가지다:

```
Io(Os { code: 5, kind: PermissionDenied, message: "액세스가 거부되었습니다." })
```

대상의 진단도 그중 하나다(`usage_budget_policy.rs:2227`, `set:`). 즉 **대상은 고유한 결함이
아니라 저장 경로 하나를 공유하는 여러 시험 중 하나였다.** 시험끼리의 간섭도 아니다 — 시험은
각자 tempdir 로 격리돼 있고, 깨진 자리는 전부 자기 tempdir 안에 **제품 코드가 저장하는** 순간이다.

호출 사슬은 하나로 모인다:

```
store::save_metadata / usage_budget_policy::set_consumer / accounts::…
  → app_data_file::write_private_json
    → app_data_file::write_private_bytes
      → app_data_file::replace_file        ← 여기
```

`replace_file` 의 Windows 갈래는 `MoveFileExW(.., MOVEFILE_REPLACE_EXISTING |
MOVEFILE_WRITE_THROUGH)` 한 번이고 **재시도가 없다**(`app_data_file.rs:57`). Windows 에서 이
호출은 방금 만들어진 임시 파일이나 목적지를 다른 프로세스(Defender 실시간 검사·검색
인덱서·백업 에이전트)가 스캔하려고 잠깐 열어 두면 `ERROR_ACCESS_DENIED`(5) 로 **일시적으로**
실패한다. 파일을 막 쓰고 `sync_all` 한 직후가 스캐너가 붙기 가장 좋은 순간이라, 부하가 높을수록
확률이 오른다 — 전건 병렬 실행에서만 깨지고 단독 실행은 멀쩡한 이유가 이것으로 설명된다.

### 그래서 이 회차는 고치지 않았다

고칠 자리가 시험이 아니라 **제품 코드**(`app_data_file::replace_file`)다. 회차 절차 5절이
"원인이 제품에 있으면 거기서 멈추고 결정으로 올린다"로 정해 두었으므로, 손대지 않고 보고의
`decisions` 로 올렸다. 시험 쪽에서 통과시키는 길(재시도·`sleep`·단언 완화)은 전부 절차가
금지한 다섯 가지에 해당한다.

남은 두 건은 다른 원인이다 — `project_git::tests::c16_auth_failure_against_a_real_remote_…`
가 2/20 으로 깨졌고 진단은 `Recv failure: Connection was aborted` 다. 시험이 띄운 로컬 git
서버와의 경합이라 위 저장 경로와 무관하고, 그쪽은 제품이 아니라 시험 하네스 쪽이다.


## 2026-10-06 3회차 실측 (레인 L20 · test-threads 기본 · Windows) — 다른 레인에서 같은 진단이 다시 나왔다

2회차의 좁히기가 **한 레인에서만 본 것**인지 가르려고, 다른 레인(L20)에서 같은 자로 전건
10회를 다시 돌렸다. 제품도 시험도 고치지 않았다 — 2회차가 올린 결정(아래)이 아직 열려 있어
고칠 자리에 손댈 수 없다.

| 블록 | 대상 실패 | 아무 시험이나 실패 | 깨진 시험 건수 |
|---|---|---|---|
| 10회 | **0/10** | 4/10 | 5 |

깨진 다섯 건은 또 서로 다른 네 시험이었다.

| 시험 | 횟수 | 진단 |
|---|---|---|
| `project_instructions::…requires_the_current_digest` | 2 | `Io(Os { code: 5, kind: PermissionDenied })` |
| `backend_service_settings::…schema_v1_is_migrated_atomically…` | 1 | `Io(Os { code: 5, kind: PermissionDenied })` |
| `project_git::…c16_auth_failure_against_a_real_remote…` | 1 | `Recv failure: Connection was aborted` |
| `system_workflows::…common_chat_runtime_is_approved_and_applied…` | 1 | `assertion left == right: 2 != 3` |

**2회차의 결론이 레인을 바꿔도 그대로 섰다.** 이번에는 2회차에 없던
`project_instructions`·`system_workflows` 가 새로 나왔고, 진단 다섯 중 셋이 또 글자 그대로
`code 5 PermissionDenied` 다. 즉 흔들리는 단위는 시험도 모듈도 아니라 **저장 경로**이고,
어느 시험이 그 순간 저장하고 있었느냐에 따라 깨지는 이름만 바뀐다. 대상 시험을 쫓는 일이
의미가 없는 이유가 이것이다 — 대상은 이번 10회에서 0회 깨졌지만 같은 원인은 세 번 나왔다.

나머지 둘은 저장 경로가 아니다. `project_git` 은 2회차와 같은 로컬 git 서버 경합이고,
`system_workflows::common_chat_runtime_is_approved_and_applied_to_each_paced_provider` 는
이번에 처음 나온 **단언 불일치**(2 ≠ 3)라 진단이 전혀 다르다. 이 둘은 각각 따로 봐야 한다.

### 이 회차도 고치지 않았다

2회차가 올린 결정(`replace_file` 의 Windows 갈래에 짧은 재시도를 넣을지)이 아직 답이 없다.
절차 5·9절대로 제품 동작은 회차가 바꾸지 않으므로 이 회차는 **측정만** 했고, 같은 결정을
다시 올리지도 않았다(중복 금지). 답이 나오기 전까지 다음 회차가 할 수 있는 일도 같다 —
숫자를 더 쌓는 것뿐이다.

## 2026-10-06 4회차 실측 (레인 L01 · test-threads 기본 · Windows) — 깨진 다섯 건이 **전부** 같은 진단이었다

2·3회차와 같은 자로 전건 30회(기준선 10 + 확인 20)를 돌렸다. 2회차가 올린 결정이 아직 열려
있어 제품도 시험도 고치지 않았다.

| 블록 | 대상 실패 | 아무 시험이나 실패 | 깨진 시험 건수 |
|---|---|---|---|
| 10회(기준선) | 0/10 | 0/10 | 0 |
| 20회(확인) | **0/20** | 4/20 | 5 |

깨진 다섯은 또 서로 다른 다섯 시험이고, 3회차와 겹치는 이름이 하나도 없다. 그런데 **진단은
다섯 중 다섯이 글자 그대로 하나다.**

| 시험 | 자리 | 진단 |
|---|---|---|
| `scheduler::…an_antigravity_schedule_waits_until_a_default_account_is_chosen` | `scheduler.rs:4459` | `Io(Os { code: 5, kind: PermissionDenied })` |
| `accounts::…a_failed_isolation_probe_overrides_the_profile_dir_until_its_retry_passes` | `accounts.rs:10220` | 〃 |
| `accounts::…account_note_is_saved_per_account_and_survives_a_registry_reload` | `accounts.rs:9614` | 〃 |
| `accounts::…a_newer_profile_chain_is_adopted_even_after_its_access_token_expired` | `accounts.rs:9677` | 〃 |
| `store::…folder_reorder_moves_one_step_among_siblings_only` | `store.rs:1538` | 〃 |

2회차는 7건 중 5건, 3회차는 5건 중 3건이었고 이번은 **5건 중 5건**이다. 세 회차에 걸쳐 모듈도
시험 이름도 한 번도 겹치지 않았는데 진단만 같다 — "흔들리는 단위는 시험이 아니라 저장 경로"라는
2회차의 결론을 가장 세게 받치는 블록이다. 다섯 자리는 모두 제품의 저장 호출이다
(`register_current`·`create_session_folder` → `write_private_json` → `replace_file`).

대상 시험은 이번에도 0/30이다. 세 회차 합계로 대상은 100회 중 1회 깨졌고, 같은 진단은
그보다 훨씬 자주 나왔다. **대상 시험 이름을 쫓는 일은 이제 의미가 없다.**

### 이 회차가 고친 것 — 판정 축을 손이 아니라 도구가 세게 했다

제품은 그대로 두고(결정이 열려 있다), 2회차 보고가 `next` 로 남긴 "판정은 '진단이 code 5 인
실패 종류'가 사라졌는지로 한다"를 도구가 할 수 있게 했다. 지금까지 이 사실은 세 회차 모두
사람이 로그를 눈으로 읽어 세야 했고, 그래서 문서에만 남았다.

- `diagnosticSignature` — 진단 블록을 견줄 수 있는 한 줄로 줄인다. OS 오류는 코드와 kind 만
  남긴다(`Io(os error 5 · PermissionDenied)`): `message` 는 OS 로캘을 타고 경로는 실행마다
  다른 tempdir 이라, 그대로 두면 같은 원인이 매번 다른 지문이 된다. 그 밖에는 panic 메시지의
  첫 줄을 쓰고 `left:`/`right:` 값은 넣지 않는다. 더 묶지는 않는다 — 과하게 묶으면 3회차의
  단언 불일치처럼 원인이 다른 것이 한 지문에 합쳐진다.
- `RunSummary.failureCountsByDiagnostic` — 지문별 **실행 수**와 그 지문을 공유한 시험 이름들.
  한 실행에서 같은 지문이 둘 나와도 1 회다(옆의 다른 숫자가 전부 실행 수다).
- `diagnosticKinds` — 지문 축을 `failureKinds` 와 같은 모양으로 낸다. 그래서
  `compareFailureKinds` 가 그대로 "사라진 종류 / 새로 생긴 종류"를 찍는다.
  기존 세 종류(대상·다른 시험·빌드)는 **건드리지 않았다** — 기준선 파일과 회차 절차가 이미
  쓰는 계약이라 늘리면 지난 기준선과 견줄 수 없다.
- 러너는 두 축을 함께 찍고, 보고 JSON 에 `diagnosticKinds` 와
  `comparedToBaselineDiagnostics` 를 싣는다. 기준선이 이 축을 갖기 전에 적힌 것이면 비교는
  `null` 이다 — 없는 것을 0 으로 읽으면 전부 "새로 생긴 종류"가 되어 회귀로 오인된다.

다음 회차는 `진단 · Io(os error 5 · PermissionDenied): N회` 한 줄로 판정할 수 있다.

## 2026-10-06 5회차 실측 (레인 L01 · test-threads 기본 · Windows) — 깨진 다섯이 또 한 진단, 대상은 0/30

전건 30회(기준선 10 + 확인 20)를 돌렸다. 2회차가 올린 결정이 아직 열려 있어 제품도 시험도
고치지 않았다.

| 블록 | 대상 실패 | 아무 시험이나 실패 | 깨진 시험 건수 | 판정 |
|---|---|---|---|---|
| 10회(기준선) | 0/10 | 2/10 | 1 | `suite-flaky` |
| 20회(확인) | **0/20** | 4/20 | 5 | `suite-flaky` |

20회 블록에서 깨진 다섯은 서로 다른 다섯 시험(`scheduler` 넷, `accounts` 하나)인데 지문은
**`Io(os error 5 · PermissionDenied)` 하나뿐이다**(4회 실행 · 5개 시험). 4회차가 지문 축을
도구로 옮긴 덕에 이번에는 사람이 로그를 세지 않고 한 줄로 읽었다.

| 회차 | 깨진 건수 | 그중 `code 5` |
|---|---|---|
| 2회차 | 7 | 5 |
| 3회차 | 5 | 3 |
| 4회차 | 5 | 5 |
| 5회차(20회 블록) | 5 | **5** |

대상은 이번에도 0/30이고 네 회차 합계로 **130회 중 1회**다. 반면 같은 진단은 회차마다 나왔다.

기준선 10회 블록에서 깨진 하나는 `project_git::…c16_auth_failure_against_a_real_remote…`
(2회)로, 2·3회차와 같은 로컬 git 서버 경합이다. 저장 경로와 무관하다.

### 이 회차가 고친 것 — 지문이 포트 번호 때문에 갈리던 자리

기준선 블록에서 **같은 시험의 같은 실패 2회가 지문 둘로 갈렸다.** 진단 첫 줄에 시험이 띄운
로컬 서버 주소가 들어 있고 포트가 실행마다 달랐기 때문이다(`127.0.0.1:2150` ·
`127.0.0.1:6401`). 그래서 2회짜리 한 원인이 1회짜리 두 원인으로 찍혔다 — 4회차가 OS 오류의
`message`·경로에 대해 막아 둔 함정과 같은 것이 포트 자리에 남아 있었다.

`diagnosticSignature` 가 **루프백 주소의 포트만** 지운다(`127.0.0.1:<포트>`). 원격 주소의
포트는 원인을 가르는 정보일 수 있으므로 건드리지 않는다. 고정된 시험은
`로컬 서버 포트만 다른 진단은 같은 지문으로 묶인다` 다.

> 이 기준선(`baseline.json`, 10회 블록)은 **고치기 전에** 적혔으므로 포트가 박힌 지문 둘을
> 갖고 있다. 다음 회차가 `comparedToBaselineDiagnostics` 를 읽을 때 그 둘은 "사라진 종류"로
> 찍히지만 사라진 것이 아니라 한 지문으로 합쳐진 것이다. 회귀로 읽지 않는다.

### 이 회차도 제품은 고치지 않았다

2회차의 결정(`replace_file` 의 Windows 갈래에 짧은 재시도를 넣을지)이 네 회차째 열려 있다.
절차 5·9절대로 제품 동작은 회차가 바꾸지 않는다. 같은 결정을 다시 올리지도 않았다.

## 2026-10-06 6회차 실측 (레인 L01 · test-threads 기본 · Windows) — 판정 축이 화면에 찍히지 않던 것을 고쳤다

같은 자로 전건 30회(기준선 10 + 확인 20)를 다시 돌렸다. 2회차가 올린 결정이 여섯 회차째
열려 있어 제품도 시험도 고치지 않았다.

| 블록 | 대상 실패 | 아무 시험이나 실패 | 깨진 시험 건수 |
|---|---|---|---|
| 10회(기준선) | 0/10 | 2/10 | 2 |
| 20회(확인) | **0/20** | 4/20 | 4 |

대상은 이번에도 0/30 이다. **2~6회차 합계로 대상은 160회 중 1회 깨졌다.** 깨진 여섯 건은
또 서로 다른 여섯 시험이고 2~5회차의 이름과 하나도 겹치지 않는데, 진단 지문으로 묶으면
넷이 다시 `Io(os error 5 · PermissionDenied)` 다.

| 블록 | 지문 | 회 |
|---|---|---|
| 10회 | `Io(os error 5 · PermissionDenied)` | 1 |
| 10회 | `assertion failed: matches!(result, Err(CoreError::Conflict(_)))` | 1 |
| 20회 | `Io(os error 5 · PermissionDenied)` | 3 |
| 20회 | `assertion left == right failed: push: … AuthFailed로 분류되지 않는다 … 127.0.0.1:<포트>` | 1 |

마지막 줄이 5회차가 고친 자리의 실측 확인이다 — 포트가 지문에서 `<포트>` 로 지워져 있다.
5회차 기준선이 갖고 있던 포트 박힌 지문 둘은 이번 기준선에서 `gone` 으로 찍혔고, 그것은
회귀가 아니라 5회차가 예고한 대로 **한 지문으로 합쳐진 뒤 이번 블록에 그 원인이 나오지
않은 것**이다. 이번 기준선은 정규화 뒤에 적혔으므로 그 함정은 여기서 닫힌다.

### 이 회차가 고친 것 — 비교 축이 화면에 한 줄도 나오지 않았다

회차 절차 6절은 "출력의 `comparedToBaseline` 이 사라진 종류·새로 생긴 종류를 찍는다. 이것을
그대로 보고의 `failureKinds` 에 옮긴다"를 전제로 보고를 쓰게 한다. 그런데 러너는 이 둘을
**payload 에만 담고 화면에는 찍지 않았다.** 네 회차 내내 사람이 JSON 을 따로 열어 읽어야
했고, 4회차가 약속한 "지문 한 줄로 판정한다"가 반쪽만 선 이유가 이것이다.

- 판정 줄 바로 아래에 두 비교 축을 찍는다. 기준선이 그 축을 갖기 전에 적힌 것이면
  `견주지 않았다` 로 명시한다 — `null` 을 0 으로 읽으면 전부 "새로 생긴 종류"가 된다.
- **분모를 제목에 같이 찍는다**(`기준선 10회 ↔ 이번 20회`). 비교는 실행 수가 아니라 횟수를
  견주므로, 기준선이 10회이고 이번이 20회면 같은 빈도라도 숫자가 두 배로 보인다. 이번
  20회 블록의 `Io(os error 5): 1 → 3` 이 바로 그 자리다 — 빈도로는 1/10 ↔ 3/20 이다.
  비교 함수 자체는 건드리지 않았다. 기준선 파일의 계약이라 바꾸면 지난 기준선과 못 견준다.
- `--write-baseline` 이 `--out` 을 조용히 삼키던 것을 고쳤다. 둘 다 주면 둘 다 적는다.
  기준선은 다음 회차가 덮어쓰므로, 삼켜진 쪽은 **그 블록의 실행 기록이 통째로 사라지는**
  것이었다(이 회차의 기준선 블록도 처음에 그렇게 잃었다).

## 2026-10-06 7회차 실측 (레인 L01 · test-threads 기본 · Windows) — 대상 0/30, 지문은 또 같은 하나

같은 자로 전건 30회(기준선 10 + 확인 20)를 돌렸다. 2회차가 올린 결정이 일곱 회차째 열려
있어 **제품도 시험도 고치지 않았다.** 이 회차는 측정만 한다.

| 블록 | 대상 실패 | 아무 시험이나 실패 | 깨진 시험 건수 |
|---|---|---|---|
| 10회(기준선) | 0/10 | 1/10 | 1 |
| 20회(확인) | **0/20** | 4/20 | 4 |

대상은 이번에도 0/30 이다. **2~7회차 합계로 대상은 190회 중 1회 깨졌다.** 깨진 다섯 건은
또 서로 다른 다섯 시험이고(`accounts`·`project_git`·`remote`·`usage_budget_policy`) 지난
회차들의 이름과 겹치지 않는데, 지문으로 묶으면 넷이 다시 `Io(os error 5 · PermissionDenied)` 다.

| 블록 | 지문 | 회 |
|---|---|---|
| 10회 | `Io(os error 5 · PermissionDenied)` | 1 |
| 20회 | `Io(os error 5 · PermissionDenied)` | 3 |
| 20회 | `assertion left == right failed: pull: … AuthFailed로 분류되지 않는다 … 127.0.0.1:<포트>` | 1 |

마지막 줄은 6회차가 본 것과 같은 `project_git` 의 로컬 git 서버 경합인데, 그때는 `push:`
였고 이번은 `pull:` 이라 지문이 `new` 로 찍혔다. 같은 시험·같은 원인이 호출 방향에 따라
다른 지문을 받는 자리다 — 지문을 더 묶을지는 원인이 다른 것을 합칠 위험이 있어 손대지 않았다.

여섯 회차 연속으로 같은 결론이 선다: **흔들리는 단위는 시험도 모듈도 아니라 저장 경로**이고,
대상 시험 이름을 쫓는 일에는 더 이상 남은 정보가 없다. 열려 있는 두 결정
(`app_data_file::replace_file` 의 Windows 재시도 · 이 목표의 대상을 진단 축으로 바꿀지)이
답을 받기 전까지 다음 회차가 할 수 있는 일도 숫자를 더 쌓는 것뿐이다.

## 2026-10-06 8회차 실측 (레인 L01 · test-threads 기본 · Windows) — 깨진 넷이 **전부** 같은 지문

같은 자로 전건 30회(기준선 10 + 확인 20)를 돌렸다. 2회차가 올린 결정이 여덟 회차째 열려
있어 **제품도 시험도 도구도 고치지 않았다.** 이 회차는 측정만 한다.

| 블록 | 대상 실패 | 아무 시험이나 실패 | 깨진 시험 건수 | 판정 |
|---|---|---|---|---|
| 10회(기준선) | 0/10 | 1/10 | 1 | `suite-flaky` |
| 20회(확인) | **0/20** | 3/20 | 3 | `suite-flaky` |

대상은 이번에도 0/30 이다. **2~8회차 합계로 대상은 220회 중 1회 깨졌다.**

깨진 넷은 또 서로 다른 넷이고 지난 회차들의 이름과 겹치는 것은 하나뿐인데
(`accounts::…a_newer_profile_chain_is_adopted…` 가 4회차에 이어 두 번째), 지문으로 묶으면
**넷 중 넷이 `Io(os error 5 · PermissionDenied)`** 다. 4회차(5/5) 이후 다시 나온 전건 일치다.

| 시험 | 자리 |
|---|---|
| `scheduler::…active_account_option_follows_the_account_active_at_run_time` | `scheduler.rs:4467` |
| `store::…bound_account_keeps_being_updated_but_is_not_the_resume_basis` | `store.rs:1168` |
| `accounts::…revalidating_an_inactive_claude_credential_restores_ready_without_activating_it` | `accounts.rs:8684` |
| `accounts::…a_newer_profile_chain_is_adopted_even_after_its_access_token_expired` | `accounts.rs:9677` |

이번에는 `project_git` 의 로컬 git 서버 경합도, 단언 불일치도 한 건도 나오지 않았다. 즉 이
30회에서 흔들린 것은 **저장 경로 하나뿐**이었다. 기준선 대비 비교도 두 축 모두 `same` /
`up`(1 → 3, 분모는 10 ↔ 20 이라 빈도로는 1/10 ↔ 3/20) 으로, 새로 생긴 종류는 없다.

일곱 회차 연속으로 같은 결론이 선다 — 대상 시험 이름을 쫓는 일에는 더 이상 남은 정보가 없다.
열려 있는 두 결정(`app_data_file::replace_file` 의 Windows 재시도 · 이 목표의 대상을 진단
축으로 바꿀지)이 답을 받기 전까지 다음 회차가 할 수 있는 일도 숫자를 더 쌓는 것뿐이다.

## 쓰는 법

```
npm run flaky:isolate -- --mode=suite  --runs=10            # 전건 10회 (검증 명령 그대로)
npm run flaky:isolate -- --mode=solo   --runs=10            # 대상만 10회 (대조군)
npm run flaky:isolate -- --mode=serial --runs=5             # 전건 1스레드 (병렬이 원인인지 가른다)
npm run flaky:isolate -- --mode=with --with=a::b,c::d       # 대상 + 지목한 시험만
npm run flaky:isolate -- --mode=bisect --repro-runs=4       # 함께 돌 때만 깨지는 최소 묶음 좁히기
npm run flaky:isolate -- --mode=suite --runs=10 --write-baseline
```

- `--expect=flaky` — 재현 단계에서 쓴다. 깨지는 것이 성공이라 종료 코드를 뒤집는다.
- `--json` — 사람이 읽을 줄 대신 구조만 찍는다. `--out <경로>` 로 파일에도 적는다.
- 기준선은 `docs/flaky-tests/baseline.json` 하나다. 다음 측정은 자동으로 이것과 견주어
  **사라진 종류 / 새로 생긴 종류**를 함께 찍는다.

## 읽을 때 조심할 것

- **판정은 실패 종류다.** 합격 횟수는 참고 수치다. 종류는 셋 — `대상 시험 실패`,
  `다른 시험 간헐 실패`, `빌드·링크 실패`.
- **음성은 약한 증거다.** `--mode=with` 나 `--mode=bisect` 가 "미재현"을 내도 그 묶음이
  무죄라는 뜻이 아니라 그 횟수 안에 안 나왔다는 뜻이다. 좁힌 결과는 `--repro-runs` 를 올려
  다시 확인한다.
- **부분 실행은 조건을 바꾼다.** 시험 몇 건만 돌리면 스레드 수와 기계 부하가 달라져, 타이밍에
  기댄 간헐 실패는 재현이 더 어려워진다. 최종 판정은 언제나 `--mode=suite` 로 한다.
- **`verdict: broken`** 은 측정이 성립하지 않았다는 뜻이다(빌드 실패이거나 대상이 한 번도 돌지
  않았다). 통과로 읽지 않는다.
- **축이 둘이다.** 시험 이름 축(`failureCountsByTest`)과 진단 지문 축
  (`failureCountsByDiagnostic`·`diagnosticKinds`). 2~4회차에서 이름은 회차마다 전부 바뀌었고
  진단은 같았다 — 이름 축만 보면 "매번 다른 시험이 한 번씩 깨진다"는 잡음으로 읽힌다. 원인이
  하나인지 여럿인지는 **지문 축**으로 본다.
