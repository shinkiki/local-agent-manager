# C19 절 — AGENTS.md에 옮긴 본문 (반영 완료, 2026-10-02)

> **이미 AGENTS.md에 들어갔다.** 다시 붙이지 않는다. 옮길 때 사용자 결정을 두 자리에 반영했다 —
> C19-2는 (나)(v1은 민감 경로 예외 등록을 열지 않는다), C19-4는 **원격 write 모드 허용**이다.
> 아래 본문의 해당 두 단락은 결정 전 초안이므로 AGENTS.md 쪽이 정본이다. 이 파일은 무엇을 왜
> 바꿔 옮겼는지 남기려고 보존한다. 같은 날 두 레인이 이 본문을 동시에 옮겼고(문구만 다르고
> 결정은 같았다) AGENTS.md에 먼저 반영된 쪽이 정본이다.

`docs/project-menu/c19-draft.md`가 **왜** 이 예외가 필요한지와 갈리는 자리를 적은 문서라면,
이 파일은 사용자가 승인했을 때 AGENTS.md 3절 표 아래에 **그대로 붙일 본문**이다. 두 파일을
가른 이유는, 초안 문서는 계획 대조·선택지·근거를 담아야 하고 AGENTS 본문은 조건만 담아야
해서다. 한 파일에 둘을 섞으면 옮기는 회차가 무엇까지 옮길지를 다시 판단해야 한다.

옮기는 회차가 할 일은 셋이다.

1. 아래 잘림표 두 줄 사이를 AGENTS.md의 `### C18 — cask quarantine release` 절 뒤에 붙인다.
2. 3절 직접변경 예외 표에 C19 행 하나를 더한다(아래 "표 행" 참고). **다른 행은 건드리지 않는다**
   — 병렬 회차가 같은 표를 쓴다.
3. C19-2의 `(가)`/`(나)` 중 **사용자가 고른 쪽만** 남기고 다른 쪽 줄을 지운다. 둘 다 남긴 채
   반영하면 규칙이 두 가지를 동시에 말한다.

고르지 않은 채로는 2번까지만 해도 `R1`·`R2`는 통과한다(probe는 `^### C19 —` 제목과
`C19-1`~`C19-5` 문자열을 본다). 그러나 `O*` 구현은 C19-2의 답이 있어야 시작할 수 있다.

## 표 행

| # | Adapter | Write target | Recovery | Remote in write mode |
| --- | --- | --- | --- | --- |
| C19 | local overlay adapter (`project_overlays.rs`) | 앱 데이터의 `<app data>/git-overlays/`, 그리고 스냅샷·적용 시점에만 **등록된 활성 프로젝트** 작업 트리의 선택된 추적 파일 | patch를 먼저 쓰고 digest까지 확인한 뒤에만 되돌리고, 재적용은 `git apply --check`가 통과할 때만 한다. 세트 삭제는 앱 소유 휴지통으로 옮긴다 | 읽기는 열려 있고, 세트 저장·삭제와 작업 트리를 바꾸는 스냅샷·적용 모두 write mode에서 원격 가능(2026-10-02 사용자 결정) |

--- 8< ---

### C19 — local overlay adapter

브랜치마다 다른 로컬 설정(디버그 플래그, 로컬 포트, 실험용 상수)을 브랜치를 옮길 때마다 손으로
되돌리는 일을 없앤다. overlay는 추적 중인 파일의 unstaged 변경을 patch로 떠서 앱 데이터에
보관하고, 작업 트리를 HEAD 원본으로 되돌렸다가, 나중에 같은 patch를 다시 적용한다. 그 되돌림이
`git restore --source=HEAD --worktree`이고 **C16-4가 명시로 금지한 명령**이라, C16 안에서는 쓸 수
없다. 또 patch는 캐시가 아니라 **사용자 로컬 데이터**다 — C2처럼 "공급자가 다시 만든다"는 복구
근거가 없으므로 복구 근거를 patch 저장 순서 자체가 진다.

- **C19-1** 세트는 `<app data>/git-overlays/<저장소 식별자>/<세트 id>/`에만 쓴다. 사용자 저장소
  안에는 patch도 메타데이터도 잠금 파일도 두지 않는다 — 저장소 안에 두면 그 파일이 브랜치를
  따라다니고, overlay가 없애려던 문제를 overlay가 다시 만든다. 식별자와 세트 id는 단일 경로
  성분으로 검증하고(C3-6), 대상 파일 경로는 `classify_relative_path`·`assert_within_root`를
  지나며 `.git` 성분과 pathspec 매직을 거절한다(C16-5, G10). patch는
  `git diff --binary --full-index`로 뜬다 — `--full-index`가 없으면 축약 blob 해시가 재적용
  시점에 모호해지고 `--binary`가 없으면 바이너리 변경이 조용히 빠진다. 저장은 staged write 뒤
  atomic replace이고 디렉터리는 `0700`, patch 파일은 `0600`이다. 메타데이터는 repository
  identity, canonical root, 대상 경로, snapshot id, 생성 시점, 기준 HEAD, patch digest, 적용
  상태만 담는다. 파일 내용과 patch 본문은 메타데이터에 들어가지 않는다.
- **C19-2** patch 본문에는 파일 **내용**이 그대로 들어가므로, `.env`, `*.pem`, `*.key`, `id_*`,
  `credential`/`credentials`, `secrets`, `.npmrc`, `.netrc`에 걸리는 경로는 기본 제외하고 **사유와
  함께 거절**한다. G4가 금지하는 것은 Agent Manager 파일에 비밀값을 남기는 것이고, 앱 데이터
  안의 patch가 바로 그 파일이다. 거절은 조용하지 않다 — 어느 경로가 어느 규칙에 걸렸는지
  영수증에 싣는다.
  - *(가를 고른 경우)* 예외 등록은 **경로 건별**로 호스트에서 명시적으로 확인받고, 허용된
    경로를 세트 메타데이터에 기록해 목록 화면에 상시 표시한다. 세트 단위 확인은 허용하지
    않는다 — 한 번의 확인이 나중에 더해진 경로까지 덮기 때문이다.
  - *(나를 고른 경우)* v1은 예외 등록을 제공하지 않는다. 거절 사유만 보여 주고, 민감 경로를
    overlay에 넣는 길은 열지 않는다.
- **C19-3** 이 예외가 더하는 git 명령은 정확히 둘이다 — `git restore --source=HEAD --worktree`
  (patch 저장이 성공한 **뒤에만**)와 `git apply`(재적용). C16-4가 금지한 나머지는 여전히
  금지다: 어떤 `--force*`도, `reset --hard`도, `clean`도, `--amend`도, 대화형 rebase도 이 예외가
  열지 않는다. `git checkout`은 worktree 복원에 쓰지 않는다(`restore`가 범위가 좁다). 순서가
  안전의 전부다 — patch를 쓰고 fsync하고 digest를 확인한 뒤에 되돌리므로, 저장이 실패하면 작업
  트리는 한 글자도 바뀌지 않는다. 재적용은 `git apply --check`가 먼저 돌고, 실패하면 아무것도
  적용하지 않은 채 `overlayNeedsResolution`과 충돌한 `affected` 경로를 돌려준다. 부분 적용과
  3-way 자동 병합은 v1에 없다 — 절반 적용된 작업 트리는 이 기능이 되돌릴 수 없는 상태다.
  자동 검사·적용은 **앱이 시작한** Git 작업(switch/pull/rebase/merge) 뒤에만 하고, 터미널 같은
  외부 Git 작업을 감지한 경우에는 자동 적용하지 않고 검사 결과와 적용 버튼만 내민다. Git 작업
  자체가 실패하면 이전 브랜치에서 재적용을 시도하고, 그 재적용까지 실패해도 **patch는
  보존하고** 복구 영수증을 남긴다 — patch를 잃는 경로는 어디에도 없다. v1이 지원하는 것은
  HEAD에 있는 추적된 일반 파일의 unstaged 변경뿐이고, `untracked`, `staged`, `deleted`,
  `rename`, `modeChange`, `submodule`, `conflicted`, `symlink`, `unbornHead`는 등록 또는 스냅샷
  생성을 사유와 함께 거절한다. 저장소 하나에 변경 하나다 — C16-3의 저장소 단위 잠금을 git
  어댑터와 **공유**해 overlay 적용과 `git` 변경이 서로를 가로지르지 않게 하고, 겹치면 `busy`를
  돌려준다.
- **C19-4** 읽기(`list_project_overlay_sets`, `check_project_overlay_apply`)는 원격 UI에 열린다.
  세트 저장·삭제(`save_project_overlay_set`, `delete_project_overlay_set`)와 작업 트리를 바꾸는
  둘(`snapshot_project_overlay`, `apply_project_overlay`)은 모두 쓰기 게이트를 지나고 **write
  mode에서 원격 가능**하다(2026-10-02 사용자 결정). 초안은 뒤의 둘을 C16-7의 push와 같은 부류로
  보아 호스트 전용으로 제안했으나, push가 호스트 전용인 이유는 호스트 사용자의 자격증명으로
  **바깥으로** 내보내기 때문이고 overlay는 바깥으로 나가지 않는다. 남는 위험은 "화면 앞에 없는
  사이 작업 트리가 바뀐다"인데, 그 답은 권한 경계가 아니라 복구성이다 — patch를 먼저 쓰고
  digest까지 확인한 뒤에만 되돌리고, 재적용은 `--check`가 통과할 때만 하고, 모든 변경이 C19-5의
  영수증을 남기므로 무엇이 왜 바뀌었는지 영수증만으로 되짚을 수 있다. G11의 하나뿐인 결정
  지점(`remoteWrite`)이 이것을 진다. 따라서 호스트 전용 목록(`is_host_only_command`)에는 overlay
  명령이 **하나도 들어가지 않는다**.
- **C19-5** 모든 overlay 변경은 오류가 아니라 영수증을 남긴다(C16-6과 같은 모양). 최소 필드는
  `head_before`/`head_after`(되돌림의 기준점), `snapshot_id`, `patch_digest`(저장한 patch의
  SHA-256, 적용 시점에 같은 patch인지 확인한다), `outcome`(`applied`/`overlayNeedsResolution`/
  `rejected`/`busy`), `affected`(검사 실패 시 충돌한 경로), `rejected`(거절한 경로와 사유),
  `trigger`(`app`/`external` — 자동 적용했는지 버튼을 내밀었는지)다. 영수증에는 patch 본문도
  파일 내용도 싣지 않는다(G4). 세트 삭제는 지우지 않고 앱 소유 휴지통으로 옮긴다(C3-11) —
  patch는 사용자 로컬 데이터이고, 지우면 그 변경의 유일한 사본이 사라진다.

--- 8< ---

## probe 적합성 (2026-10-02, 레인 L14 실측)

위 본문을 AGENTS.md에 붙인 상태를 `evaluateCheck`로 그대로 돌려 확인했다.

- `R1.rule`(`agentsRule`)은 `^###\s+C19\s+—` 정규식을 본다. 제목의 구분자는 em dash(`—`)여야
  하고 hyphen(`-`)이면 통과하지 않는다. 위 제목은 em dash다.
- `R2.clauses`(`requiredLiterals`)는 `C19-1`~`C19-5` 문자열이 AGENTS.md에 있는지만 본다.
  `**C19-1**` 같은 강조 안에 있어도 포함이므로 통과한다.

그래서 C19-2의 한 줄을 고르는 일 말고는 옮기는 회차가 문구를 다시 손볼 이유가 없다.
