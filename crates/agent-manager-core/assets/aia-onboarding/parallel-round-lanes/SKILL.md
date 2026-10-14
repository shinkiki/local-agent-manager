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
# 회수선은 120분이다. 긴 cargo 빌드가 이것을 넘길 수 있으므로 살아 있는 회차는
# 반드시 아래 keepalive 규칙대로 `lane-$LANE/at` 을 찍어 시각을 갱신해야 한다.
find "$POOL/.lease" -mindepth 1 -maxdepth 1 -type d -name 'lane-*' -mmin +120 -exec rm -rf {} + 2>/dev/null
# `lane-*`이 디렉터리가 아니면 그것은 점유가 아니라 교착이다 — keepalive `touch`가 이미
# 반납된 lease를 0바이트 일반 파일로 되살린 자리다. 그 파일이 있는 한 `mkdir`은 영원히
# 실패하는데, 바로 위 스윙은 `-type d`라 파일을 집지 않아 스스로 풀리지 않는다. 그래서
# 시각과 무관하게 지운다(2026-10-06 실측 — 좀비 keepalive 루프 하나가 L01을 6시간 막았다).
find "$POOL/.lease" -mindepth 1 -maxdepth 1 ! -type d -name 'lane-*' -delete 2>/dev/null
# 지난 회차가 `rm -rf` 대신 이름만 바꿔 둔 잔재. 쌓이면 `mkdir` 대신 `ls`로 점유를
# 가날하려는 회차가 전 레인이 찬 것으로 오독한다(2026-10-06 실측 — 38건 쌓여 있었다).
find "$POOL/.lease" -mindepth 1 -maxdepth 1 -type d \( -name 'released-*' -o -name 'returned-*' \) -mmin +1440 -exec rm -rf {} + 2>/dev/null
ORDER=$(seq -f 'L%02g' 1 "$LANES" | awk -v n=$(( ${RANDOM:-0} % LANES )) '{a[NR]=$0} END{for(i=1;i<=NR;i++) print a[((i+n-1)%NR)+1]}')
LANE=""; for n in $ORDER; do
  [ -e "$POOL/.lease/blocked-$n" ] && continue
  mkdir "$POOL/.lease/lane-$n" 2>/dev/null && { LANE=$n; break; }
done
[ -n "$LANE" ] || { echo NO-FREE-LANE; ls "$POOL/.lease"; exit 3; }
date > "$POOL/.lease/lane-$LANE/at"; echo "LANE=$LANE"
```

- 시작 지점을 무작위로 돌려 회차들이 앞에서부터 줄서지 않게 한다.
- **점유 여부는 `mkdir`의 성패로만 판단한다.** `ls`로 먼저 훑어 "차 있어 보인다"로
  물러나지 않는다 — `.lease`에는 점유가 아닌 이름(`items`·`push`·`blocked-*`·잔재)이
  섞여 있어 눈으로 세면 틀린다. `NO-FREE-LANE`은 레인 전부에서 `mkdir`이 실제로
  실패했을 때만 쓴다.
- `blocked-<레인>`은 사람이 손봐야 하는 레인이라 건너뛴다(6-3).
- `NO-FREE-LANE`이면 **작업을 시작하지 말고** 점유·차단 목록과 함께 보고하고 끝낸다.
- **120분** 넘게 그대로인 점유는 죽은 회차로 보고 회수한다. 그러므로 **120분을 넘길 일을
  할 때는 keepalive가 선택이 아니다** — 긴 빌드·연속 측정 앞뒤에서
  `touch "$POOL/.lease/lane-$LANE/at"`로 살아 있다는 표시를 남긴다. **디렉터리가 아니라
  그 안의 파일을 찍는다.** 디렉터리 이름을 찍으면 7절에서 반납한 뒤에 그 이름이 0바이트
  일반 파일로 되살아나 그 레인이 영구히 막힌다.
- **keepalive를 백그라운드 루프로 돌리지 않는다.** 긴 명령 앞뒤에서 전경으로 한 번씩
  찍는다. 루프는 회차가 끝나도 살아남아 남의 레인을 막는다 — 기다리던 산출물이 끝내
  나오지 않은 `until [ -f <파일> ]; do touch ...; sleep 20; done` 하나가 6시간 동안 L01을
  막았다(2026-10-06 실측). 꼭 필요하면 pid를 잡아 두고 7절에서 죽인다.
  ```sh
  ( while :; do touch "$POOL/.lease/lane-$LANE/at"; sleep 60; done ) & KEEPALIVE=$!
  ```
- 레인을 잡았으면 **어떤 경로로 끝나든 7절에서 반납한다.**

## 금지 — 주 워크트리에서 작업하지 않는다

`$MAIN`은 사용자와 다른 회차의 작업장이다. **거기서 파일을 고치거나 커밋하는 일은 어떤
경우에도 없다.** 레인이나 워크트리를 얻지 못하면 아무것도 하지 않고 그 사실만 보고한다.
허용되는 것은 `git -C "$MAIN" fetch`와 6-1의 조건부 push 한 줄뿐이다.

## 1. 레인 워크트리와 미반영 커밋

```sh
WT="$POOL/wt-$LANE"; DEV=<지시문의 레인 작업브랜치>
# 작업브랜치는 보통 `<리모트>/<가지>`다. 반영할 때 둘을 따로 써야 하므로 여기서 한 번만
# 가른다 — 가지 이름에 슬래시가 있어도(`upstream/feature/x`) 리모트는 첫 조각뿐이다.
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
# Windows(MSYS)에서는 pwd -P 가 /f/... 를, git 은 F:/... 를 돌려줘 문자열 비교가 언제나 어긋난다.
# cygpath -m 으로 git 과 같은 표기에 맞춘다. cygpath 가 없는 OS 에서는 pwd -P 그대로다(2026-10-05).
[ "$(git rev-parse --show-toplevel)" = "$(cd "$WT" && { cygpath -m "$(pwd -P)" 2>/dev/null || pwd -P; })" ] || { echo NOT-IN-LANE; exit 6; }
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
# `-mindepth 1`이 없으면 find가 items 디렉터리 **자신**을 지워 동시에 도는 다른 레인의
# 점유가 통째로 날아간다(2026-10-06 실측).
find "$POOL/.lease/items" -mindepth 1 -maxdepth 1 -type d -mmin +120 -exec rm -rf {} + 2>/dev/null
mkdir "$POOL/.lease/items/$ITEM" 2>/dev/null || { echo ITEM-TAKEN; }   # 다른 항목을 고른다
```

`ITEM-TAKEN`이면 다른 항목으로 넘어간다. 잡을 항목이 하나도 없으면 아무것도 만들지 말고
"남은 항목 없음"으로 보고하고 끝낸다. 항목 점유는 7절에서 레인과 함께 반납한다.

경로는 겹칠 수 있다. 겹친 결과는 6절의 rebase가 정리하고, 거기서 충돌하면 그 회차가
그 자리에서 푼다(6-3).

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
  touch "$POOL/.lease/lane-$LANE/at"     # 디렉터리가 아니라 그 안의 파일을 찍는다(0절)
  ```
  빌드나 연속 측정이 120분을 넘길 수 있으면 **중간에도 한 번씩 더 찍는다** —
  회수선이 120분이라 그렇게 하지 않으면 살아 있는 내 레인을 남이 가져간다.
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

남은 변경이 있으면 먼저 커밋한다. rebase 는 더러운 워크트리에서 시작하지 않으므로, 여기서
멈추면 반영이 통째로 밀린다. 이 레인에서 만들어진 것은 이 회차의 일감이니 버리지 않는다 —
소유 밖 경로만 4절 규칙대로 되돌리고 나머지는 커밋에 담는다.

```sh
cd "$WT" || exit 1
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -q -m "<회차 제목> (레인 $LANE 잔여분)"
fi
find "$POOL/.lease" -mindepth 1 -maxdepth 1 -type d -name push -mmin +15 -exec rm -rf {} + 2>/dev/null
mkdir "$POOL/.lease/push" 2>/dev/null || { echo LOCK-BUSY; exit 4; }
echo "$LANE" > "$POOL/.lease/push/owner"
[ -n "$REMOTE" ] && { git fetch -q "$REMOTE" || git fetch -q "$REMOTE"; }
BASE=$(git merge-base HEAD "$DEV")
echo "INCOMING>>"; git log --name-only --pretty= "$BASE".."$DEV" | sort -u; echo "<<"
if git rebase -q "$DEV"; then echo REBASED-OK; else echo REBASE-CONFLICT; git status --short; fi
```

`REBASE-CONFLICT`면 **되돌리지 말고 그 자리에서 푼다.** 예전에는 `--abort` 하고 다음
회차에 넘겼는데, 그러면 같은 자리가 회차마다 다시 충돌해 레인이 막히고 반영이 계속 밀린다.

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

### 6-3. 충돌은 푼다 — 다만 힘으로 밀지는 않는다

충돌한 파일마다 **양쪽을 다 읽고** 합친다. 내 변경으로 덮거나(`--ours`) 들어온 변경으로
덮는(`--theirs`) 일괄 처리는 하지 않는다 — 그건 푸는 것이 아니라 한쪽을 버리는 것이고,
버려진 쪽은 이미 작업브랜치에 반영된 남의 변경이다.

```sh
git diff --name-only --diff-filter=U        # 충돌한 파일
# 파일마다 열어서 양쪽 의도를 살려 고친다
git add <푼 파일>
git rebase --continue
```

푼 뒤에는 **반드시 3절 검증을 다시 돌린다.** 충돌을 풀었다는 것은 코드가 방금 바뀌었다는
뜻이라, 풀기 전의 통과 기록은 더 이상 이 커밋을 보증하지 않는다. 검증까지 통과하면
6-1부터 다시 실행해 반영한다.

보고에는 **어떤 파일에서 무엇과 무엇이 부딪혔고 어느 쪽을 어떻게 살렸는지** 적는다.
무인 실행이라 사람이 나중에 읽고 판단할 근거가 이 기록뿐이다.

풀 수 없을 때만 물러난다 — 양쪽 의도가 정말로 배타적이거나, 들어온 변경의 맥락을 알 수
없어 살릴 방법을 모르겠을 때다.

```sh
git rebase --abort
rm -rf "$POOL/.lease/push"
```

**`--force`는 어느 경우에도 하지 않는다.** 커밋은 레인 브랜치에 남기고 무엇이 왜 풀리지
않았는지 보고한다. 다음 회차 1절이 그 브랜치를 이어받고, 거기서도 실패하면 그 레인을 막고
다른 레인으로 옮긴다.

```sh
touch "$POOL/.lease/blocked-$LANE"     # 다음 회차들은 이 레인을 건너뛴다
rm -rf "$POOL/.lease/lane-$LANE"       # 점유 반납 뒤 0절부터 새 레인으로
```

사용자가 정리한 뒤 `rm "$POOL/.lease/blocked-<레인>"`로 다시 연다.

## 7. 반납 — 어떤 경로로 끝나든 한다

```sh
[ -n "$KEEPALIVE" ] && kill "$KEEPALIVE" 2>/dev/null   # 0절에서 띄웠으면 반드시 죽인다
rm -rf "$POOL/.lease/lane-$LANE"
[ -n "$ITEM" ] && rm -rf "$POOL/.lease/items/$ITEM"
```

**반납은 이름을 바꾸는 것이 아니라 지우는 것이다.** `released-*`·`returned-*`로 바꿔 두면
`.lease`에 잔재가 쌓여 다음 회차가 점유 상황을 오독한다(0절).

반납 전에 **이 회차가 띄운 백그라운드 프로세스가 하나도 남지 않았는지** 확인한다.
keepalive·감시 루프·`tail -f`가 살아남으면 레인을 반납해도 레인이 열리지 않는다.

워크트리와 빌드 디렉터리는 남긴다. 다음 회차가 재사용한다.

## 8. 보고 — 응답의 마지막에 반드시 남긴다

무인으로 돌고 결과는 마지막 턴 출력으로만 회수된다.

- 잡은 레인(중간에 옮겼으면 그 경위와 차단한 레인)과 점유한 항목
- 1절에서 본 미반영 커밋 유무
- 한 일과 변경 파일
- 실행한 검증과 결과 줄
- 커밋 해시와 반영 결과(`REBASED-OK`/`REBASE-CONFLICT`/`LOCK-BUSY`, 민 해시)
- 외부 상태를 바꿨는지(반영 뒤에만)
- 레인·항목을 반납했는지, 띄운 백그라운드 프로세스를 전부 거뒀는지
- 다음 회차 몫으로 남긴 것

`NO-FREE-LANE`·`WORKTREE-FAILED`·디스크 부족·검증 실패·반영 실패로 끝났을 때도 무엇을
확인하고 왜 멈췄는지 같은 형식으로 보고한다. `NO-FREE-LANE`을 적을 때는 `ls "$POOL/.lease"`
결과를 그대로 붙인다 — 몇 번 레인에서 `mkdir`이 실패했는지가 사람이 볼 증거다.
