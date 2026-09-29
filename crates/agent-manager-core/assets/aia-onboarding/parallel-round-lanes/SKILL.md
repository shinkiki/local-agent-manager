---
name: parallel-round-lanes
description: 같은 저장소에서 여러 무인 회차가 동시에 도는 절차. 레인을 점유하고 레인 전용 워크트리에서만 일하고 반영을 락 하나로 직렬화한다. 온보딩이 병렬을 켜고 만든 회차 워크플로가 이 절차를 따른다. "레인", "병렬 회차", "동시 실행 회차", "반영 충돌" 같은 상황에 사용한다.
---

# 병렬 회차 레인 절차

## Shell prerequisite

Run the command blocks in a POSIX `sh` shell. On Windows, use Git Bash or WSL; do not paste or translate the blocks into PowerShell or `cmd.exe`. If no POSIX shell is available, make no changes and report that environment prerequisite.

여러 회차가 같은 저장소에서 **동시에** 돈다. 충돌하지 않는 이유는 레인이다 — 회차마다
레인 하나를 점유하고, 그 레인 전용 워크트리에서만 일하고, 반영은 락 하나로 직렬화한다.

이 스킬은 기계장치만 담는다. **무엇을 할지는 회차 지시문이 정하고**, 레인 수·풀 경로·
레인 작업브랜치·반영 방식·분할 모델 같은 값도 지시문 앞머리의 `## 병렬 실행` 블록이 준다.
그 블록이 없으면 이 회차는 병렬이 아니므로 이 절차를 쓰지 않는다. 지시문 본문에
프로젝트의 작업브랜치가 따로 적혀 있어도, 레인이 갈라지고 반영하는 지점은
`레인 작업브랜치` 한 줄이다.

## 왜 레인을 앱이 배정하지 않는가

회차 봉투는 실행마다 번호(`index`)를 알지만, 계약의 지시문은 고정 문자열이라 그 번호를
글 안에 심을 수 없다. 그래서 **레인은 각 회차가 스스로 집는다.** 집는 행위 자체가
원자적이어야 두 회차가 같은 레인을 잡지 않으므로 `mkdir`의 원자성을 쓴다.

## 0. 레인 점유 — 못 잡으면 아무것도 하지 않는다

```sh
MAIN=<지시문의 저장소 경로>; POOL=<지시문의 레인 풀>; LANES=<지시문의 병렬 수>
mkdir -p "$POOL/.lease"
# 제외 항목은 저장소에서 본 풀의 상대 경로다. 고정 문자열로 적으면 기본값이 아닌 풀이,
# 이름만 떼어 적으면 중첩 풀(`ci/rounds`)이 제외되지 않아 레인 워크트리와 빌드 산출물이
# 주 워크트리의 git status에 그대로 올라온다.
EXCLUDE="/${POOL#"$MAIN"/}/"
grep -qx "$EXCLUDE" "$MAIN/.git/info/exclude" 2>/dev/null || echo "$EXCLUDE" >> "$MAIN/.git/info/exclude"
find "$POOL/.lease" -maxdepth 1 -type d -name 'lane-*' -mmin +180 -exec rm -rf {} + 2>/dev/null
ORDER=$(seq -f 'L%02g' 1 "$LANES" | awk -v n=$(( ${RANDOM:-0} % LANES )) '{a[NR]=$0} END{for(i=1;i<=NR;i++) print a[((i+n-1)%NR)+1]}')
LANE=""; for n in $ORDER; do
  [ -e "$POOL/.lease/blocked-$n" ] && continue
  mkdir "$POOL/.lease/lane-$n" 2>/dev/null && { LANE=$n; break; }
done
[ -n "$LANE" ] || { echo NO-FREE-LANE; ls "$POOL/.lease"; exit 3; }
date > "$POOL/.lease/lane-$LANE/at"; echo "LANE=$LANE"
```

- 시작 지점을 무작위로 돌려 회차들이 앞에서부터 줄서지 않게 한다.
- `blocked-<레인>`은 사람이 손봐야 하는 레인이라 건너뛴다(6-3).
- `NO-FREE-LANE`이면 **작업을 시작하지 말고** 점유·차단 목록과 함께 보고하고 끝낸다.
- 180분 넘게 그대로인 점유는 죽은 회차로 보고 회수한다. 긴 빌드 전에는
  `touch "$POOL/.lease/lane-$LANE"`로 살아 있다는 표시를 남긴다.
- 레인을 잡았으면 **어떤 경로로 끝나든 7절에서 반납한다.**

## 금지 — 주 워크트리에서 작업하지 않는다

`$MAIN`은 사용자와 다른 회차의 작업장이다. **거기서 파일을 고치거나 커밋하는 일은 어떤
경우에도 없다.** 레인이나 워크트리를 얻지 못하면 아무것도 하지 않고 그 사실만 보고한다.
허용되는 것은 `git -C "$MAIN" fetch`와 6-1의 조건부 push 한 줄뿐이다.

## 1. 레인 워크트리와 미반영 커밋

```sh
WT="$POOL/wt-$LANE"; DEV=<지시문의 레인 작업브랜치>
# 작업브랜치는 보통 `<리모트>/<가지>`다. 반영할 때 둘을 따로 써야 하므로 여기서 한 번만
# 가른다 — 가지 이름에 슬래시가 있어도(`private/dev-history`) 리모트는 첫 조각뿐이다.
# 슬래시가 없으면 리모트 없는 로컬 가지다. 그때는 fetch도 push도 하지 않는다.
case "$DEV" in
  */*) REMOTE="${DEV%%/*}"; BRANCH="${DEV#*/}" ;;
  *)   REMOTE=""; BRANCH="$DEV" ;;
esac
[ -n "$REMOTE" ] && { git -C "$MAIN" fetch -q "$REMOTE" || git -C "$MAIN" fetch -q "$REMOTE"; }
if [ ! -d "$WT" ]; then
  git -C "$MAIN" worktree add -B "round/lane-$LANE" "$WT" "$DEV" \
    || git -C "$MAIN" worktree add -B "round/lane-$LANE" "$WT" "$DEV"
fi
[ -d "$WT" ] || { echo WORKTREE-FAILED; rm -rf "$POOL/.lease/lane-$LANE"; exit 5; }
cd "$WT"
git rev-list --count "$DEV".."round/lane-$LANE"    # 0이 아니면 아래
```

레인 작업브랜치가 저장소에 없어도 **만들지 않는다.** 여러 회차가 나눠 쓰는 지점이라
한 회차가 지어내면 다른 회차는 다른 곳에 반영한다. 그 이름이 맞는지 사람이 정하도록
`WORKTREE-FAILED`로 끝낸다 — 진행·QA 회차가 자기 작업브랜치를 만드는 것과 다른 점이다.

같은 `.git`을 여러 회차가 동시에 쓴다. `fetch`·`push`·`worktree add`가 `cannot lock ref`·
`index.lock` 같은 경합으로 실패하면 **같은 명령을 한 번 더** 실행한다. 두 번째도 실패하면
주 워크트리로 돌아가지 말고 보고하고 끝낸다. `git worktree prune`은 다른 레인이 워크트리를
만드는 중에 끼어들 수 있으므로 회차 안에서 돌리지 않는다.

**미반영 커밋이 0이 아니면 지난 회차가 반영하지 못한 것이다.** 새 일감을 잡지 말고 6절을
먼저 실행해 그 커밋을 반영한다. 반영에 성공하면 이어서 2절로 가고, 두 번째도 실패하면
레인을 차단하고 다른 레인으로 옮긴다(6-3).

남은 커밋이 없으면 레인을 작업브랜치 최신으로 새로 깐다.

```sh
# 되감기 전에 여기가 레인 워크트리인지 확인한다. `cd`가 실패했거나 워크트리가 사라졌으면
# 아래 세 줄은 **사용자의 주 워크트리를 비운다.**
[ "$(git rev-parse --show-toplevel)" = "$(cd "$WT" && pwd -P)" ] || { echo NOT-IN-LANE; exit 6; }
git reset --hard -q && git clean -fdq
git checkout -q -B "round/lane-$LANE" "$DEV"
git status --short        # 비어 있어야 한다. 아니면 멈추고 보고
```

`NOT-IN-LANE`이면 레인 워크트리 밖이다. **아무것도 되돌리지 말고** 점유를 반납하고
그 사실만 보고한다.

gitignore 대상이라 새 워크트리에 딸려오지 않는 것(`node_modules`, 로컬 설정 파일 등)은
주 워크트리 것을 심볼릭 링크로 쓴다 — 의존성은 회차가 바꾸지 않는다.

```sh
ln -sfn "$MAIN/node_modules" node_modules   # 있는 프로젝트만
```

## 2. 일감을 나눠 갖는다 — 지시문이 고른 분할 모델대로

### 항목 점유(`분할: 항목 점유`)

일감이 마일스톤 항목·시나리오처럼 셀 수 있는 단위일 때. **점유는 로컬 파일시스템으로
한다.** 노션·지라를 점유 표시로 쓰면 두 회차가 같은 순간에 읽고 둘 다 잡는다.

```sh
ITEM=<고른 항목 id>
mkdir -p "$POOL/.lease/items"
find "$POOL/.lease/items" -maxdepth 1 -type d -mmin +180 -exec rm -rf {} + 2>/dev/null
mkdir "$POOL/.lease/items/$ITEM" 2>/dev/null || { echo ITEM-TAKEN; }   # 다른 항목을 고른다
```

`ITEM-TAKEN`이면 다른 항목으로 넘어간다. 잡을 항목이 하나도 없으면 아무것도 만들지 말고
"남은 항목 없음"으로 보고하고 끝낸다. 항목 점유는 7절에서 레인과 함께 반납한다.

경로는 겹칠 수 있다. 겹친 결과는 6절의 rebase가 정리하고, 거기서 충돌하면 다음 회차가
이어받는다.

### 경로 소유(`분할: 경로 소유`)

지시문의 분할표에서 이 레인이 소유한 경로만 고친다. **소유 경로 밖은 한 줄도 고치지
않는다** — 다른 레인이 같은 순간에 그 파일을 고치고 있다고 가정하라. 소유 밖 파일을
고쳐야만 성립하는 일감은 고르지 않고 "단독 회차 주제"로 보고에 남긴다.

## 3. 검증 — 레인끼리 자원을 나눠 쓴다

프로젝트의 검증 절차(AGENTS.md·CLAUDE.md의 검증 절)를 그대로 따르되, 다음을 지킨다.

- 조용한 리포터는 선택이 아니다. 통과 출력은 인용하지 않고 결과 줄만 남긴다.
- Rust가 있으면 레인 전용 빌드 디렉터리를 쓴다. 공유하면 재빌드가 폭주한다.
  ```sh
  export CARGO_TARGET_DIR="$POOL/target/$LANE" CARGO_BUILD_JOBS=2
  df -g / | tail -1      # 여유가 40G 미만이면 빌드하지 말고 그대로 보고하고 끝낸다
  touch "$POOL/.lease/lane-$LANE"
  ```
- 포트를 여는 검증(e2e·개발 서버)은 레인마다 다른 포트를 쓴다.
- 레인의 빌드 디렉터리는 회차가 끝나도 지우지 않는다. 디스크가 부족할 때만 자기 것을 비운다.

검증이 실패하면 **커밋하지 않고** 원인과 함께 보고한다.

## 4. 커밋

```sh
git rev-parse --show-toplevel     # $WT여야 한다. $MAIN이면 커밋하지 말고 보고
git status --short                # 경로가 전부 이 레인 몫인지 눈으로 확인
git add -A
git commit -m "<프로젝트 규칙에 맞는 제목>"
```

경로 소유 모델에서 소유 밖 경로가 하나라도 있으면 `git checkout -- <그 경로>`로 되돌린 뒤
커밋한다. 본문에 레인 번호와 (항목 점유면) 항목 id를 한 줄 남긴다.

## 5. 외부 상태는 반영 뒤에만 바꾼다

마일스톤 항목·티켓·이력처럼 저장소 밖에 있는 상태는 **6절 반영이 성공한 뒤에** 완료로
바꾼다. 반영 전에 완료로 바꾸면, 반영에 실패해 커밋이 레인 브랜치에 남았는데 다음 회차는
그 항목을 끝난 것으로 보고 건너뛴다. 반영 전에 남길 것이 있으면 "진행 중"과 레인·브랜치만
적는다.

## 6. 반영 — push 락으로 직렬화한다

지시문의 `반영: 로컬 커밋만`이면 이 절을 건너뛴다. 커밋은 레인 브랜치에 남고 사람이 합친다.

### 6-1. 락을 잡고 작업브랜치 위로 옮긴다

```sh
cd "$WT" || exit 1
find "$POOL/.lease" -maxdepth 1 -type d -name push -mmin +15 -exec rm -rf {} + 2>/dev/null
mkdir "$POOL/.lease/push" 2>/dev/null || { echo LOCK-BUSY; exit 4; }
echo "$LANE" > "$POOL/.lease/push/owner"
[ -n "$REMOTE" ] && { git fetch -q "$REMOTE" || git fetch -q "$REMOTE"; }
BASE=$(git merge-base HEAD "$DEV")
echo "INCOMING>>"; git log --name-only --pretty= "$BASE".."$DEV" | sort -u; echo "<<"
if git rebase -q "$DEV"; then echo REBASED-OK; else git rebase --abort; echo REBASE-CONFLICT; fi
```

`LOCK-BUSY`면 다른 레인이 반영 중이다. **같은 블록을 다시 실행한다(최대 5회).** 5회 모두
실패하면 커밋을 레인 브랜치에 남긴 채 보고하고 끝낸다 — 다음 회차 1절이 이어받는다.

### 6-2. 재검증이 필요한지 판단하고 민다

`INCOMING` 목록에 **내가 고친 파일이나 공유 파일이 하나도 없으면** 재검증 없이 민다.

```sh
[ -n "$REMOTE" ] || { echo NO-REMOTE; rm -rf "$POOL/.lease/push"; }   # 아래 참고
git push "$REMOTE" HEAD:"$BRANCH" && git rev-parse --short HEAD
rm -rf "$POOL/.lease/push"
```

`NO-REMOTE`면 작업브랜치에 리모트가 없다(로컬 가지). 밀 곳이 없으므로 **밀지 않는다** —
커밋을 레인 브랜치에 남기고 "리모트 없는 작업브랜치이라 반영하지 않았다"로 보고한다.
사람이 합치거나, 지시문의 레인 작업브랜치를 `<리모트>/<가지>`로 고친다.

겹치는 파일이 있으면 **락부터 놓고**(`rm -rf "$POOL/.lease/push"`) 3절을 다시 돌린다.
락을 쥔 채 빌드하면 다른 레인이 그만큼 멈춰 선다. 재검증을 통과하면 6-1부터 다시 실행해
반영하고, 실패하면 rebase로 들어온 변경과 내 변경 중 어느 쪽이 깨졌는지 적어 보고한다
(되돌리지 말고 레인 브랜치에 그대로 둔다).

push가 경합 오류로 실패하면 한 번 더 실행한다. 비속행 거부는 6-3으로 간다.

### 6-3. 충돌·거부는 힘으로 풀지 않는다

```sh
rm -rf "$POOL/.lease/push"
```

**`--force`도 재리베이스도 하지 않는다.** 커밋은 레인 브랜치에 남기고 어떤 파일이
충돌했는지 보고한다. 다음 회차 1절이 그 브랜치를 이어받아 다시 반영을 시도하고, 거기서도
실패하면 그 레인을 막고 다른 레인으로 옮긴다.

```sh
touch "$POOL/.lease/blocked-$LANE"     # 다음 회차들은 이 레인을 건너뛴다
rm -rf "$POOL/.lease/lane-$LANE"       # 점유 반납 뒤 0절부터 새 레인으로
```

사용자가 정리한 뒤 `rm "$POOL/.lease/blocked-<레인>"`로 다시 연다.

## 7. 반납 — 어떤 경로로 끝나든 한다

```sh
rm -rf "$POOL/.lease/lane-$LANE"
[ -n "$ITEM" ] && rm -rf "$POOL/.lease/items/$ITEM"
```

워크트리와 빌드 디렉터리는 남긴다. 다음 회차가 재사용한다.

## 8. 보고 — 응답의 마지막에 반드시 남긴다

무인으로 돌고 결과는 마지막 턴 출력으로만 회수된다.

- 잡은 레인(중간에 옮겼으면 그 경위와 차단한 레인)과 점유한 항목
- 1절에서 본 미반영 커밋 유무
- 한 일과 변경 파일
- 실행한 검증과 결과 줄
- 커밋 해시와 반영 결과(`REBASED-OK`/`REBASE-CONFLICT`/`LOCK-BUSY`, 민 해시)
- 외부 상태를 바꿨는지(반영 뒤에만)
- 레인·항목을 반납했는지
- 다음 회차 몫으로 남긴 것

`NO-FREE-LANE`·`WORKTREE-FAILED`·디스크 부족·검증 실패·반영 실패로 끝났을 때도 무엇을
확인하고 왜 멈췄는지 같은 형식으로 보고한다.
