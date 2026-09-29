# 계획 일관성 조사 — 2026-09-26

작업 9.10 H. 모델은 qwen3.5-gpu-128k:latest. CPU는 사용자가 9.11을 측정 중이므로
호출하지 않았다. 이 기록은 **계획 내용의 일관성 해결 보고가 아니다**. 이번 반영은
기록한 도구 단계를 answer_now가 버리고 실행 없이 완료하는 전이 하나를 고친다.
노션 누락·파일 쓰기로 대체·계획 중 직접 호출 후 잘못된 거절은 남는다.

## 가설과 구별 방법

코드 변경 전에 원본 세션의 계획 호출·추론·응답을 읽었다. provider DB는 읽기 전용으로
열었으며 원본 기록은 수정하지 않았다.

| 세션 | 실제 경로 | 판별 |
| --- | --- | --- |
| ses_f23842cd6ffeSajm2cvlyffGrb | 처음에는 웹과 노션을 모두 생각함. webfetch 직접 호출 오류, 거절된 tools:[] 단계, 되묻기 뒤 조사 중복과 write로 확정 | 거절된 초안과 수락된 초안의 구분이 무너짐. 되묻기는 증폭할 수 있지만 단독 원인은 아님 |
| ses_f23700d3fffenlmkGmKZf7PmvG | webfetch → write → notion-create-pages, 되묻기 없음 | 기존 표면에서도 올바른 조합 가능 |
| ses_f236b4a12ffektksvs1f3BEJFC | 처음에는 웹과 노션을 생각했으나 webfetch 하나 뒤 finish_plan, 되묻기 없음 | MAX_PLAN_NUDGES 문구만 고쳐서는 설명하거나 해결할 수 없음 |

가설 A: 수락된 초안이 응답에 없어 거절된 단계를 이미 추가했다고 기억한다.
add_step 응답과 되묻기에 원래 요청·수락된 초안을 함께 주는 snapshot을 대조한다.
가설 B: 확정 전에 요청 전체를 덮는지 확인하지 않는다. snapshot에 첫 finish_plan을
검토 응답으로 돌리는 review를 더해 대조한다. 가설 C: 긴 색인이 주의를 분산한다.
색인 길이·도구를 동시에 바꾸면 A/B와 분리할 수 없으므로 이번에는 고정하고 미검증으로 남긴다.

모든 설정 비교는 한 과제 n≥20, 같은 회차 표식을 공유하는 AB/BA 순서로 번갈아 실행한다.
온도·모델·맥락 창은 바꾸지 않는다. 실패는 노션 자리 누락, 복수 도구 한 단계,
조기 answer_now, 잘못된 거절, 되묻기 한도로 나누며 제목과 전체 호출도 보존한다.
도구 이름의 단순 반복은 중복 실패로 단정하지 않는다. 서로 다른 URL 조사일 수 있다.

## 먼저 바로잡은 측정기

기존 index-probe는 제품과 다른 도구 수·상한·오류 응답·종료 처리를 가지고 있었다.
제품의 스키마, 전체 색인, 계획 요청, add_step 응답, 되묻기, 상한, 정규화 오류를
Rust 시험에서 fixtures/planning-contract.json으로 내보낸다. 시험은 현재 제품과
사본 전체가 같은지 검사한다. chat과 system_mcp는 기존 문구를 PlanDraft 공통 함수로
옮겼을 뿐 응답 내용과 되묻기 횟수는 바뀌지 않는다. edit과 insert_step도 빠뜨리지 않는다.

OpenCode 1.18.32의 invalid 설명은 실제 실행 파일의 Do not use와 맞췄다.
직접 작업 도구 호출은 Core의 친절한 오류까지 도달하지 않고 OpenCode의 unavailable
오류가 된다. 탐침도 이를 계획 단계로 대신 수락하지 않는다. 빈 필수 인자, uses,
오류 뒤 재시도도 제품 봉투 처리에 맞췄다. 60응답 안전 한도는 탐침만의 중단 사유로
기록하며 제품 실패와 섞지 않는다. 이 한도에 도달한 최종 측정은 없다.

완료되지 않은 계획을 도구 이름만으로 합격시키지 않는다. 제품 실행기는 첫 도구로
agent를 고르므로 write와 notion-create-pages를 한 단계에 묶은 예도 실패다.
탐침은 계획만 검증하며 실제 조회·노션 저장 성공까지 뜻하지 않는다.

## 채택하지 않은 후보

아래는 최종 채점 규칙으로 재채점한 탐색 기록이다. 오류 종류는 겹칠 수 있다.

| 후보 | 대조 / 후보 | 후보의 실패 | 총 응답 턴 대조 / 후보 |
| --- | --- | --- | --- |
| snapshot, 각 20회 | 14/20 / 11/20 | 노션 누락 7, 복수 도구 2 | 74 / 68 |
| review, 각 20회 | 9/20 / 11/20 | 조기 answer_now 5, 노션 누락 5, 되묻기 한도 1 | 66 / 100 |

snapshot 첫 측정에는 answer_now로 초안을 버리는 제품 동작을 탐침만 거절하는
불일치가 있었다(대조 14회차·후보 20회차). 당시 invalid 설명도 최종 제품과 달랐다.
따라서 깨끗한 제품 대조 실험으로 사용하지 않는다. review는 초안 폐기 동작을
수정 전 제품대로 맞춘 뒤 쟀지만 invalid 설명의 작은 차이는 남아 있었다.
둘 다 채택하지 않았다. 최종 제품에는 snapshot·review 문구나 추가 검토 턴이 없다.
실험 재현을 위해 탐침의 명시적 VARIANTS 옵션으로만 남겼다.

## 이번에 특정한 별도 전이 결함

수정 전 실기기 ses_f23295181ffe7RCLdD2uLHxCIF:

1. add_step: React 공식 웹사이트로부터 최신 버전 정보 검색 / webfetch.
2. answer_now: 현재 단계: React 공식 웹사이트에서 최신 안정 버전 정보 수집 중입니다.
3. 초안을 폐기하고 completed. 실제 작업 도구 실행은 0회.

PlanSlot::answer는 비어 있지 않은 초안을 보존하고 복구 가능한 오류를 돌려주도록
바꿨다. 모델은 단계를 더하거나 finish_plan으로 확정할 수 있고, cannot_do도 유지된다.
도구 단계를 쓰지 않은 인사의 answer_now는 그대로다. 요청의 의미를 키워드로 추정해
도구를 강제로 추가하거나 실행기·종합·창 크기를 바꾸지 않는다.
Rust와 JS 회귀 시험에 날짜, 실제 세션 id, 실제 제목·답변을 넣었다.

## 최종 GPU 비교

baseline은 수정 전 초안 폐기, guard는 이번 전이 보호다. 색인·시스템 프롬프트는 같다.
웹 과제는 중단 후 재개 시 7회차가 한 쌍 더 기록되어 **전부 포함한 각 21회**로 집계했다.
회차 숫자 대신 marker까지 포함해야 각각 구별된다. 선택적으로 시행을 버리지 않았다.
인사·로컬 조회는 각각 설정당 20회다. 최종 122개 기록을 현재 탐침으로 재생하여
기록된 steps와 ended가 모두 일치함을 확인했다. 후속 RPC 경계 정리는 이 기록들에서
발생하지 않은 입력만 다뤘다.

| 과제 | GPU baseline 완료 / 실패 | GPU guard 완료 / 실패 | 총 응답 턴 baseline / guard | CPU |
| --- | --- | --- | --- | --- |
| web-to-notion | 19 / 2 | 16 / 5 | 75 / 82 | 사용자 지시로 미측정 |
| greeting | 20 / 0 | 20 / 0 | 20 / 20 | 사용자 지시로 미측정 |
| local-read | 19 / 1 | 19 / 1 | 44 / 44 | 사용자 지시로 미측정 |

요청을 수행할 수 있는 과제라 정직한 거절로 채점한 경우는 없다.
웹 guard의 실패 5개는 조기 확정으로 노션 누락 1, 노션 제목에 write 선택 3,
단계 없는 잘못된 거절 1이다. 대조의 실패 2개는 노션 제목에 write 선택이다.
**19/21 → 16/21을 개선이라고 해석할 수 없다.** 기존 기준선도 같은 날 9/20과
19/21로 흔들렸다. 이 반영을 전체 계획 일관성 개선으로 채택한 것이 아니다.

전이 보호가 실제 작동한 웹 10·16회차는 answer_now를 거절받은 뒤 노션 단계를 더해
확정했다. 로컬 조회 guard 14회차도 초안을 유지한 뒤 finish_plan으로 복구했다.
이는 관찰된 복구 사례이며 작은 표본의 성공률로 설정을 고른 근거가 아니다.
로컬 조회 대조의 실패는 read 단계 뒤 answer_now로 초안 폐기,
guard의 실패는 insert_step 오류·빈 finish_plan 뒤 단계 없는 answer_now다.
후자는 빈 초안이므로 이번 보호 범위 밖이다.

## 수정 후 실기기: 실패 유지

지정 스크립트로 54181 격리 백엔드를 띄우고 같은 요청·GPU·작업 폴더로 한 판 실행했다.
세션 ses_f2311fc3affeAN8b31tAebiqdP는 add_step(webfetch) → 직접 webfetch 호출
→ OpenCode invalid → cannot_do로 끝났다. 인터넷 기능 자체가 없다고 오해한 것이다.
이번 answer_now 보호는 이 경로에서 호출되지 않았다. 노션 저장과 실제 작업 실행은
없었고, 새 문서나 파일도 만들어지지 않아 되돌릴 결과물이 없다.
백엔드는 공식 stop 명령으로 종료했고 54181 LISTEN이 없음을 확인했다.

이 판을 성공으로 보고하지 않는다. 계획 중 직접 호출 오류의 의미와 계획/실행 구분은
후속 과제다. Core의 기존 안내가 OpenCode의 도구 이름 검사보다 뒤에 있어 전달되지
않는다는 증거가 확보됐지만, 이번에는 새 경로 규칙이나 실행 도구 노출을 추가하지 않았다.

## 검증과 재현

- cargo fmt --all 및 cargo fmt --all --check 통과.
- cargo test -q -p agent-manager-core --lib: 1865 passed, 0 failed, 1 ignored.
- 계획 JS 시험 22개 통과. 전체 src/lib도 Git Bash를 PATH 맨 앞에 둔 프로세스에서 통과.
  기본 PATH의 C:/Windows/system32/bash.exe(WSL)로는 기존 refactorEvalScoring.test.mjs:330의
  임시 폴더 삭제가 EBUSY로 실패했다. 다른 세션의 소스는 수정하지 않았다.
- npx tsc --noEmit 통과. 실기기 빌드 통과. CPU 호출 없음. 운영 앱 실행·상태 변경 없음.

PowerShell에서 GPU 비교:

~~~powershell
$env:ONLY_TASK='web-to-notion'
$env:REPEATS='20'
$env:VARIANTS='baseline,guard'
$env:TRACE_FILE=Join-Path $env:TEMP 'plan-web-guard.jsonl'
node local-llm-dev/plan-eval/index-probe.mjs qwen3.5-gpu-128k:latest
~~~

NO_ALIAS=1은 동일 자리에서 한글 별칭을 뺀다. START_TRIAL은 1부터 세는 재개 회차다.
재개 전에 JSONL의 마지막 완결된 쌍을 확인한다. SUMMARY는 그 프로세스에서 실행한
분량만 집계하므로 재개된 파일 전체는 별도로 집계해야 한다.
계약을 의도적으로 바꿀 때는 UPDATE_PLAN_CONTRACT=1로
planning_probe_contract_matches_product 시험을 실행하고 JSON 사본까지 함께 검토한다.

원시 기록은 %TEMP%/agent-manager-plan-consistency-20260926/의
 gpu-web-v1.jsonl, gpu-web-review.jsonl, gpu-web-guard.jsonl, gpu-controls.jsonl,
 live-start.json, live-detail.json, live-post-start.json, live-post-detail.json,
 audit-summary.json에 남겼다. 공유 측정 폴더 사용 금지 이후 새 로그는 .tuning에 쓰지
않았다. 그 전에 만든 자체 로그는 옮기거나 지우지 않고 그대로 뒀다.

남은 일: CPU 레인 재검증(사용자 9.11 종료 전에는 호출 금지), 긴 색인 가설의 분리 측정,
노션 목적지/도구 불일치, 조기 finish_plan, 직접 호출 뒤 잘못된 거절.
지금 사용자에게 새 권한이나 결정을 요구할 항목은 없다.
