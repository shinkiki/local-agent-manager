# C19 — local overlay adapter 예외 초안 (사용자 결정 대기)

회차가 쓴 **초안**이다. AGENTS.md는 사용자의 공학 규칙이고 새 직접변경 예외는 앱이 사용자
디스크에 무엇을 쓸 수 있는지를 넓히는 정책 결정이라, 회차는 AGENTS.md를 고치지 않는다.
사용자가 이 초안을 승인하면 다음 회차가 `### C19 — local overlay adapter` 절로 AGENTS.md에
옮기고(`R1`·`R2` 통과), 그때부터 `O1`~`O10`·`V2`·`V4`를 고를 수 있다.

- 측정 상태(2026-10-02, 레인 L08): 항목 17/31 · 점검 41/76. 1·2·5단계(F\*·B\*·A\*)는 전부 통과하고
  남은 14항목은 전부 C19에 막혀 있다. **측정은 끝났고 남은 것은 결정뿐이다.**
- 출처(2026-10-02 갱신): 이전 판(2026-10-02, 레인 L18)은 Notion 인증이 없어 계획 원문을 읽지
  못하고 `docs/project-menu/acceptance.json`만으로 썼다. 이번 판은 계획 원문
  ([프로젝트 메뉴 고도화 및 브랜치 독립 로컬 설정 Overlay 계획](https://app.notion.com/p/8c2257f3dd7282f5a6d2815817481b4a),
  읽기만 함)을 대조해 **계획이 못박았는데 초안에 없던 것**을 채우고, **계획과 초안의 권고가
  갈리는 한 자리**(민감 경로, C19-2)를 결정으로 올렸다.

## 왜 예외가 필요한가

브랜치마다 다른 로컬 설정(디버그 플래그, 로컬 포트, 실험용 상수)을 브랜치를 옮길 때마다 손으로
되돌리는 일을 없애는 기능이다. overlay는 추적 중인 파일의 로컬 변경을 patch로 떠서 앱 데이터에
보관하고, 작업 트리를 HEAD 원본으로 되돌렸다가, 나중에 같은 patch를 다시 적용한다.

그 되돌림이 `git restore --source=HEAD --worktree <경로>`이고, **C16-4가 명시로 금지한
"worktree 파일의 restore/checkout"**이다. C16 안에서는 쓸 수 없고, 쓰려면 이 예외가 서야 한다.
또 patch는 캐시가 아니라 **사용자 로컬 데이터**다 — 지우면 그 변경은 어디에도 없다. C2(모델
카탈로그 캐시)처럼 "공급자가 다시 만든다"는 복구 근거가 없으므로, 복구 근거를 patch 저장
자체가 져야 한다.

## C19-1 — 저장 범위: patch는 저장소 밖 앱 데이터에만 쌓인다

- overlay 세트는 `<app data>/git-overlays/<저장소 식별자>/<세트 id>/`에만 쓴다. 사용자 저장소
  안에는 patch도, 메타데이터도, 잠금 파일도 두지 않는다 — 저장소 안에 두면 그 파일 자체가
  브랜치를 따라다니고, overlay가 없애려던 문제를 overlay가 다시 만든다. 계획의 완료 기준
  그대로다: "patch는 Git commit 대상이 아니고, 앱 데이터 밖에 저장되지 않는다."
- 저장소마다 세트는 여럿이다(`local-dev`, `personal-tools`, `debug`). 한 세트는 여러
  repository-relative 경로를 담는다.
- **메타데이터는 계획이 열거한 것만 담는다**: repository identity, canonical root, 대상 경로,
  snapshot id, 생성 시점, 기준 HEAD, patch digest, 적용 상태. 파일 내용·patch 본문은 메타데이터에
  들어가지 않는다.
- 저장소 식별자와 세트 id는 단일 경로 성분으로 검증하고(C3-6과 같은 규칙), 경로를
  canonicalize해 그 뿌리 밖으로 나가면 거절한다(G10). 대상 파일 경로는 C16-5와 같이
  `classify_relative_path`·`assert_within_root`를 지나고 `.git` 성분과 pathspec 매직을 거절한다.
- patch는 `git diff --binary --full-index`로 뜬다. `--full-index`가 없으면 축약 blob 해시가
  재적용 시점에 모호해지고, `--binary`가 없으면 바이너리 변경이 조용히 빠진다.
- 저장은 staged write 뒤 atomic replace다(계획 실행 규칙 2). 디렉터리는 `0700`, patch 파일은
  `0600`으로 만든다.
- 점검표 근거: `O7.store`(`git-overlays`, `app_data`), `O1.list/save/delete`.

## C19-2 — 민감 경로: 기본 거절 — 예외를 열지 말지가 결정이다

- patch 본문에는 파일 **내용**이 그대로 들어간다. `.env`, `*.pem`, `*.key`, `id_*`,
  `credentials`/`credential`, `secrets`, `.npmrc`, `.netrc` 같은 경로는 기본 제외하고
  **사유와 함께 거절**한다. G4가 금지하는 것은 "Agent Manager 파일에 비밀값을 남기는 것"이고,
  앱 데이터 안의 patch는 그 Agent Manager 파일이다. 여기까지는 계획과 초안이 같다.
- 거절은 조용하지 않다: 어느 경로가 어느 규칙에 걸렸는지 영수증에 싣는다.
- **계획과 초안이 갈리는 자리다.** 계획 원문은 "예외 등록에는 **명시적 확인을 요구한다**"고
  적어 예외가 열리는 것을 전제한다. 이전 초안의 권고는 **v1에서는 열지 않는 것**이었다 —
  로컬 설정 overlay의 본래 쓰임(디버그 플래그·포트)은 민감 파일을 필요로 하지 않고, 한 번
  열면 그 patch는 평문 비밀값을 담은 채 앱 데이터에 무기한 남는다. 두 쪽이 양립하지 않으므로
  사용자가 고른다.
  - **(가) 계획대로 연다** — 확인은 호스트 전용이고, 허용된 경로를 세트 메타데이터에 기록해
    목록 화면에 상시 표시한다. 확인은 세트 단위가 아니라 **경로 건별**이어야 한다.
  - **(나) v1은 열지 않는다** — 예외 등록 자체를 다음 버전으로 미루고, 지금은 거절 사유만
    보여 준다. G4와의 마찰이 없다.
- 점검표 근거: `O7.sensitive`(`.env`, `credential`), `O6.reasons`.

## C19-3 — write-gate, 되돌릴 수 없는 명령, 자동 재적용 경계

- 상태를 바꾸는 네 작업은 전부 write-gated다: `save_project_overlay_set`,
  `delete_project_overlay_set`, `snapshot_project_overlay`, `apply_project_overlay`.
  `list_project_overlay_sets`와 `check_project_overlay_apply`는 읽기다.
- **이 예외가 더하는 git 명령은 정확히 두 개뿐이다**: `git restore --source=HEAD --worktree`
  (스냅샷이 patch 저장에 성공한 **뒤에만**)와 `git apply`(재적용). C16-4가 금지한 나머지는
  여전히 금지다 — 어떤 `--force*`도, `reset --hard`도, `clean`도, `--amend`도, 대화형 rebase도
  이 예외가 열지 않는다. `git checkout`은 worktree 복원에 쓰지 않는다(`restore`가 범위가 좁다).
- 순서가 안전의 전부다. patch를 쓰고 fsync하고 digest까지 확인한 **뒤에** 되돌린다. 저장이
  실패하면 작업 트리는 한 글자도 바뀌지 않는다.
- 재적용은 `git apply --check`가 먼저 돈다. 검사가 실패하면 **아무것도 적용하지 않고**
  `overlayNeedsResolution`과 충돌한 `affected` 경로를 돌려준다. 부분 적용·3-way 자동 병합은
  v1에 없다 — 절반 적용된 작업 트리는 이 기능이 되돌릴 수 없는 상태다. 계획의 경고 그대로다:
  "patch 실패는 Git merge/rebase conflict를 새로 만들지 않는다. 원격 Git 상태를 먼저 보존한다."
- **자동 재적용의 경계(계획 실행 규칙 8).** 앱이 시작한 Git 작업(switch/pull/rebase/merge)
  뒤에만 자동으로 검사·적용한다. 터미널 같은 **외부 Git 작업을 감지한 경우에는 자동 적용하지
  않고**, 검사 결과와 "적용" 버튼만 제공한다. 사용자가 보지 않는 사이에 작업 트리가 바뀌는 것이
  이 기능에서 가장 설명하기 어려운 사고다.
- **Git 작업 자체가 실패했을 때(계획 실행 규칙 7).** branch switch가 실패하면 이전 브랜치에서
  patch 재적용을 시도한다. 그 재적용까지 실패해도 **patch는 보존하고** 복구 영수증을 남긴다.
  patch를 잃는 경로는 어디에도 없다.
- **v1이 지원하는 것은 HEAD에 있는 추적된 일반 파일의 unstaged 변경뿐이다.** 나머지는 등록
  또는 스냅샷 생성을 거절하고 사유를 표시한다(계획 v1 범위 그대로):
  `untracked`(HEAD 원본이 없어 되돌릴 기준이 없다), `staged`, **`deleted`**, `rename`,
  **`modeChange`**, `submodule`, **이미 충돌 중인 파일(`conflicted`)**, `symlink` 또는 저장소
  루트 밖으로 해석되는 경로, `unbornHead`(첫 커밋 전 저장소).
  (앞선 초안은 `deleted`·`modeChange`·`conflicted` 셋을 빠뜨렸다. 점검표 `O6.reasons`가 요구하는
  최소 집합보다 계획의 목록이 넓으므로, 구현은 계획 쪽을 따른다.)
- 저장소 하나에 변경 하나다. C16-3의 저장소 단위 잠금을 git 어댑터와 **공유**해 overlay 적용과
  `git` 변경이 서로를 가로지르지 않게 하고, 겹치면 `busy`를 돌려준다.
- 점검표 근거: `O1.gate`, `O2.gate`, `O3.restore`, `O4.flag`, `O5.state`, `O6.reasons`,
  `O7.forbidden`, `O9.lock`.

## C19-4 — 원격 정책: 스냅샷과 적용은 호스트 전용

- 읽기(`list_project_overlay_sets`, `check_project_overlay_apply`)는 원격 UI에 열린다.
- 세트 저장·삭제(`save_project_overlay_set`, `delete_project_overlay_set`)는 write mode에서
  원격 가능하다 — 앱 데이터 안의 기록이고, 삭제는 앱 소유 휴지통으로 옮기는 회수 가능한 동작이다.
- **작업 트리를 바꾸는 둘은 호스트 전용이다**: `snapshot_project_overlay`,
  `apply_project_overlay`. C16-7이 push를 호스트 전용으로 둔 것과 같은 근거다 — 이 둘은 앱
  소유가 아닌 상태를 바꾸고, 사용자가 그 화면 앞에 없는 상태에서 작업 트리가 바뀌면 사용자는
  자기 파일이 왜 바뀌었는지 알 길이 없다. 계획도 "첫 버전의 overlay 변경·적용은 host-only를
  권장한다"로 같은 자리에 선다.
- 원격 write 허용은 복구·권한 조건을 확정한 뒤 따로 정한다.
- 점검표 근거: `O2.host`, `O5.host`, `V2.remote`.

## C19-5 — 영수증 스키마: 모든 변경이 복구 가능해야 한다

모든 overlay 변경은 오류가 아니라 영수증을 남긴다(C16-6과 같은 모양). 최소 필드:

| 필드 | 무엇 |
| --- | --- |
| `head_before` / `head_after` | 작업 전후 HEAD. 되돌림의 기준점 |
| `snapshot_id` | 이 스냅샷이 만든 세트 버전 id |
| `patch_digest` | 저장한 patch의 SHA-256. 적용 시점에 같은 patch인지 확인한다 |
| `outcome` | `applied` / `overlayNeedsResolution` / `rejected` / `busy` |
| `affected` | 검사가 실패했을 때 충돌한 경로 |
| `rejected` | 거절한 경로와 사유(C19-3의 목록, 그리고 민감 경로) |
| `trigger` | `app` / `external` — 자동 적용했는지 버튼을 내밀었는지(C19-3의 경계) |

- 영수증에는 patch 본문도 파일 내용도 싣지 않는다(G4).
- Git 작업이 실패해 되돌린 경우에도 **복구 영수증**을 남긴다(계획 실행 규칙 7): 무엇을
  되돌리려 했고, patch가 어디에 보존되어 있는지.
- 세트 삭제는 지우지 않고 앱 소유 휴지통으로 옮긴다(C3-11과 같은 모양). patch는 사용자 로컬
  데이터이고, 지우면 그 변경의 유일한 사본이 사라진다.
- 점검표 근거: `O8.receipt`, `O5.state`, `O9.lock`.

## 충돌 UX — C19가 정하는 것이 아니라 C19가 가능하게 두는 것

검사 실패 시 계획이 사용자에게 주기로 한 선택지는 다섯이다: patch 보기, AIA에게 patch 충돌
분석 요청, 대상 파일 제외, 현재 Git 기준으로 patch 다시 만들기, 검사 후 재시도. 다섯 모두
**새 git 명령을 요구하지 않는다** — "다시 만들기"는 C19-1의 `git diff`, "재시도"는 C19-3의
`--check` + `apply`다. 그래서 이 UX는 C19 절 자체에 들어가지 않고, 위 다섯 절만으로 성립한다.

## 사람이 정할 자리 (7절)

1. **C19 예외 신설 자체** — 위 다섯 절을 AGENTS.md에 올릴 것인가.
2. **민감 경로 예외 등록** — C19-2의 (가)/(나). **계획 원문과 이전 초안의 권고가 갈리는
   유일한 자리**이므로 다른 셋보다 먼저 답이 필요하다.
3. **overlay 원격 노출** — 계획과 초안이 모두 스냅샷·적용 호스트 전용을 권고한다
   (`O2.host`·`O5.host`가 그 가정이다). 확인만 하면 된다.
4. **untracked 파일 지원** — 계획과 초안이 모두 v1 거절로 일치한다(복구 기준 불명확).
   확인만 하면 된다.
