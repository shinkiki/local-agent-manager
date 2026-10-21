import type { TranslatedPhrase } from "./phrase.ts";

/**
 * 형상관리 탭 머리의 원격 동기화 버튼(원격 확인·받아서 합치기·올리기·브랜치 위로 옮기기)
 * 설명서. 버튼 옆 한 줄 title 로는 "무엇이 어디로 옮겨 가는가"가 읽히지 않아서, 그림
 * (mermaid)과 표를 담은 마크다운 한 벌을 도움말 창이 그대로 그린다.
 *
 * 문구는 백엔드가 실제로 넘기는 인수와 맞춘다 — `fetch --prune`, `pull --ff-only` /
 * `pull --rebase --no-autostash`, 업스트림이 없을 때만 `push --set-upstream`, 강제 push 없음.
 * 그 인수가 바뀌면 여기도 함께 고친다.
 */
export const GIT_SYNC_HELP: TranslatedPhrase = {
  ko: `## 한눈에 보기

Git 저장소에는 네 자리가 있습니다. 버튼은 이 자리들 사이에서 커밋을 옮기는 일을 합니다.

- **작업 폴더**: 지금 고치고 있는 파일들
- **내 브랜치**: 커밋해 둔 내 이력 (예: \`main\`)
- **원격 추적 브랜치**: 원격 저장소를 마지막으로 확인한 사본 (예: \`origin/main\`)
- **원격 저장소**: GitHub 같은 서버

\`\`\`mermaid
flowchart LR
  W["작업 폴더<br/>고친 파일"] -- "커밋" --> L["내 브랜치<br/>main"]
  R[("원격 저장소<br/>GitHub 등")] -- "① 원격 확인 (fetch)" --> T["원격 추적 브랜치<br/>origin/main"]
  T -- "② 받아서 합치기 (pull)" --> L
  L -- "③ 올리기 (push)" --> R
\`\`\`

머리에 보이는 \`origin/main ↑2 ↓3\`은 **올릴 커밋 2개, 받을 커밋 3개**라는 뜻입니다. 이 숫자는 마지막으로 원격을 확인한 때 기준이라, 정확히 보려면 먼저 **원격 확인**을 누르세요.

## 버튼별 설명

| 버튼 | git 명령 | 하는 일 | 내 파일 | 원격 |
| --- | --- | --- | --- | --- |
| 새로고침 | (상태 읽기) | 화면의 브랜치·변경·이력을 다시 읽습니다. 원격과 통신하지 않습니다. | 그대로 | 그대로 |
| 원격 확인 | \`git fetch --prune\` | 원격의 새 커밋·브랜치 정보만 받아 \`origin/…\`을 갱신합니다. 원격에서 지워진 브랜치 표식도 정리합니다. | 그대로 | 그대로 |
| 받아서 합치기 | \`git pull\` | 원격 확인을 한 뒤, 내 브랜치를 따라가는 원격 브랜치(upstream)에 맞춰 앞으로 옮깁니다. 방식은 옆 선택 상자에서 고릅니다. | **바뀜** | 그대로 |
| 올리기 | \`git push\` | 내 브랜치의 새 커밋을 원격에 올립니다. upstream이 없으면 원격에 같은 이름으로 새로 만들고 따라가도록 설정합니다. | 그대로 | **바뀜** |
| 브랜치 위로 옮기기… | \`git rebase <대상>\` | 내 브랜치에만 있는 커밋을 고른 브랜치의 끝 위에 다시 쌓습니다. | **바뀜** | 그대로 |

원격과 통신하는 버튼(원격 확인·받아서 합치기·올리기)은 설정에서 git용으로 켜 둔 SSH 키가 있으면 그 키로 인증합니다.

## 받아서 합치기: 두 가지 방식

### 빨리감기만 (안전)

내 브랜치와 원격이 **갈라지지 않았을 때만** 내 브랜치를 원격 끝까지 앞으로 감습니다. 원격에 새 커밋이 있는데 내게도 아직 안 올린 커밋이 있으면 갈라진 것입니다. 새 커밋을 만들지 않아 가장 안전하고, 갈라져 있으면 아무것도 바꾸지 않고 실패로 알려 줍니다.

\`\`\`mermaid
flowchart LR
  subgraph before["받기 전"]
    direction LR
    A1((A)) --> B1((B)) --> C1((C)) --> D1((D))
    M1["main"] -.-> B1
    O1["origin/main"] -.-> D1
  end
  subgraph after["빨리감기 후"]
    direction LR
    A2((A)) --> B2((B)) --> C2((C)) --> D2((D))
    M2["main = origin/main"] -.-> D2
  end
  before ==> after
\`\`\`

### 내 커밋 재배치 (rebase)

내 브랜치와 원격이 **갈라졌을 때** 씁니다. 원격의 새 커밋(C, D)을 먼저 받고, 내 커밋(X, Y)을 그 뒤에 하나씩 다시 쌓습니다. 다시 쌓인 커밋은 내용은 같아도 SHA가 새로 바뀝니다(X′, Y′).

\`\`\`mermaid
flowchart LR
  subgraph before["받기 전 · 갈라짐"]
    direction LR
    A1((A)) --> B1((B)) --> C1((C)) --> D1((D))
    B1 --> X1((X)) --> Y1((Y))
    O1["origin/main"] -.-> D1
    M1["main"] -.-> Y1
  end
  subgraph after["재배치 후"]
    direction LR
    A2((A)) --> B2((B)) --> C2((C)) --> D2((D)) --> X2(("X′")) --> Y2(("Y′"))
    M2["main"] -.-> Y2
  end
  before ==> after
\`\`\`

## 브랜치 위로 옮기기 (rebase)

받아서 합치기의 재배치와 같은 일을, upstream 대신 **직접 고른 브랜치**를 기준으로 합니다. 예를 들어 \`feature\` 브랜치에서 \`main\`을 고르면, \`feature\`에만 있는 커밋이 \`main\`의 최신 커밋 위로 옮겨집니다. 브랜치 목록의 우클릭 메뉴에서 "이 브랜치 위로 옮기기"를 눌러도 같습니다.

충돌이 나면 화면 위쪽 배너에서 마무리합니다.

\`\`\`mermaid
flowchart TD
  S["옮기기 시작"] --> N["다음 커밋을 대상 위에 쌓기"]
  N --> Q{"충돌?"}
  Q -- "없음" --> More{"남은 커밋?"}
  More -- "있음" --> N
  More -- "없음" --> Done["완료"]
  Q -- "있음" --> Fix["충돌 파일을 고치고 스테이지"]
  Fix --> Cont["계속"] --> More
  Q -- "있음" --> Skip["건너뛰기<br/>이 커밋은 빼고 진행"] --> More
  Q -- "있음" --> Abort["중단<br/>시작 전 상태로 되돌림"]
\`\`\`

## 어떤 버튼을 누를까요?

\`\`\`mermaid
flowchart TD
  Q{"하려는 일"}
  Q -- "원격에 무엇이 새로 왔는지만 보기" --> F["원격 확인"]
  Q -- "원격의 새 커밋을 내 브랜치로" --> P{"아직 안 올린<br/>내 커밋이 있나?"}
  P -- "없음" --> FF["받아서 합치기<br/>빨리감기만"]
  P -- "있음" --> RB["받아서 합치기<br/>내 커밋 재배치"]
  Q -- "내 커밋을 공유" --> PU["올리기"]
  PU -. "거절되면(원격이 앞서 있음)" .-> P
  Q -- "다른 브랜치 최신 위로 내 작업 옮기기" --> RE["브랜치 위로 옮기기…"]
\`\`\`

## 알아 두면 좋은 것

- **브랜치 이력 둘러보기**: 브랜치 목록에서 이름을 누르면 전환하지 않고 그 브랜치의 이력만 이력 칸에 보여 줍니다. 실제로 그 브랜치에서 일하려면 "전환"을 누르세요.
- **커밋하지 않은 변경**: '내 커밋 재배치'와 '브랜치 위로 옮기기'는 고친 파일을 자동으로 치워 두지 않습니다(autostash 안 함). 커밋하지 않은 변경이 있으면 시작하지 않고 멈추니, 커밋하거나 스태시한 뒤 다시 하세요. '빨리감기만'도 받아 오는 커밋이 고친 파일과 겹치면 멈추고, 그 파일을 결과에 적습니다.
- **이미 올린 커밋을 재배치하면** SHA가 바뀌어서 다시 올릴 때 원격이 거절합니다. 이 화면은 강제 올리기(force push)를 하지 않으니, 공유한 브랜치는 재배치하지 않는 편이 안전합니다.
- **브랜치별 로컬 변경(overlay)**을 보관해 두었다면, 전환·받아서 합치기·옮기기 뒤에 자동으로 다시 넣습니다.
- 충돌이나 막힘 결과에는 **AIA로 분석** 버튼이 붙습니다. AIA는 상태를 읽고 해결 방법만 알려 주며 파일을 바꾸지 않습니다.`,
  en: `## At a glance

A Git repository has four places. The buttons move commits between them.

- **Working folder**: the files you are editing
- **Your branch**: the history you have committed (e.g. \`main\`)
- **Remote-tracking branch**: the copy of the remote as of your last check (e.g. \`origin/main\`)
- **Remote repository**: a server such as GitHub

\`\`\`mermaid
flowchart LR
  W["Working folder<br/>edited files"] -- "commit" --> L["Your branch<br/>main"]
  R[("Remote repository<br/>GitHub etc.")] -- "① Fetch" --> T["Remote-tracking branch<br/>origin/main"]
  T -- "② Pull" --> L
  L -- "③ Push" --> R
\`\`\`

\`origin/main ↑2 ↓3\` in the header means **2 commits to push and 3 to pull**. The numbers are as of your last check of the remote, so press **Fetch** first for an accurate count.

## What each button does

| Button | git command | What it does | Your files | Remote |
| --- | --- | --- | --- | --- |
| Refresh | (read status) | Re-reads branches, changes, and history. Does not contact the remote. | unchanged | unchanged |
| Fetch | \`git fetch --prune\` | Downloads new commits and branches into \`origin/…\` and clears branches deleted on the remote. | unchanged | unchanged |
| Pull | \`git pull\` | Fetches, then moves your branch forward to its upstream. Pick the mode in the selector next to it. | **changed** | unchanged |
| Push | \`git push\` | Uploads your branch's new commits. With no upstream, creates the branch on the remote and tracks it. | unchanged | **changed** |
| Rebase onto… | \`git rebase <target>\` | Replays the commits only your branch has on top of the branch you pick. | **changed** | unchanged |

Buttons that talk to the remote (Fetch, Pull, Push) authenticate with the SSH key enabled for git in settings, if any.

## Pull: two modes

### Fast-forward only (safe)

Moves your branch forward to the remote's tip **only when the two have not diverged**. They have diverged when the remote has new commits and you also have unpushed ones. It creates no new commits, so it is the safest; if they have diverged, nothing changes and it reports a failure.

\`\`\`mermaid
flowchart LR
  subgraph before["Before"]
    direction LR
    A1((A)) --> B1((B)) --> C1((C)) --> D1((D))
    M1["main"] -.-> B1
    O1["origin/main"] -.-> D1
  end
  subgraph after["After fast-forward"]
    direction LR
    A2((A)) --> B2((B)) --> C2((C)) --> D2((D))
    M2["main = origin/main"] -.-> D2
  end
  before ==> after
\`\`\`

### Rebase my commits

Use it **when your branch and the remote have diverged**. It takes the remote's new commits (C, D) first, then replays your commits (X, Y) after them one by one. The replayed commits keep their content but get new SHAs (X′, Y′).

\`\`\`mermaid
flowchart LR
  subgraph before["Before · diverged"]
    direction LR
    A1((A)) --> B1((B)) --> C1((C)) --> D1((D))
    B1 --> X1((X)) --> Y1((Y))
    O1["origin/main"] -.-> D1
    M1["main"] -.-> Y1
  end
  subgraph after["After rebase"]
    direction LR
    A2((A)) --> B2((B)) --> C2((C)) --> D2((D)) --> X2(("X′")) --> Y2(("Y′"))
    M2["main"] -.-> Y2
  end
  before ==> after
\`\`\`

## Rebase onto…

Does the same as a rebase pull, but onto **a branch you pick** instead of the upstream. For example, picking \`main\` while on \`feature\` moves the commits only \`feature\` has on top of the latest \`main\`. "Rebase onto this branch" in the branch list's context menu does the same.

If conflicts occur, finish from the banner at the top.

\`\`\`mermaid
flowchart TD
  S["Start rebase"] --> N["Replay the next commit onto the target"]
  N --> Q{"Conflict?"}
  Q -- "no" --> More{"Commits left?"}
  More -- "yes" --> N
  More -- "no" --> Done["Done"]
  Q -- "yes" --> Fix["Fix conflicted files and stage them"]
  Fix --> Cont["Continue"] --> More
  Q -- "yes" --> Skip["Skip<br/>drop this commit"] --> More
  Q -- "yes" --> Abort["Abort<br/>back to the state before"]
\`\`\`

## Which button should I press?

\`\`\`mermaid
flowchart TD
  Q{"What do you want?"}
  Q -- "Just see what is new on the remote" --> F["Fetch"]
  Q -- "Bring remote commits into my branch" --> P{"Unpushed commits<br/>of my own?"}
  P -- "no" --> FF["Pull<br/>fast-forward only"]
  P -- "yes" --> RB["Pull<br/>rebase my commits"]
  Q -- "Share my commits" --> PU["Push"]
  PU -. "rejected (remote is ahead)" .-> P
  Q -- "Move my work onto another branch's latest" --> RE["Rebase onto…"]
\`\`\`

## Good to know

- **Browsing branch history**: click a branch name in the list to see that branch's history in the History section without switching. Press "Switch" to actually work on it.
- **Uncommitted changes**: "Rebase my commits" and "Rebase onto…" do not set your edits aside automatically (no autostash). With uncommitted changes they stop before starting; commit or stash, then try again. "Fast-forward only" also stops when incoming commits touch files you edited, and lists those files in the result.
- **Rebasing commits you already pushed** changes their SHAs, so the remote rejects the next push. This screen never force-pushes, so avoid rebasing shared branches.
- **Branch overlays** you have stored are re-applied automatically after switch, pull, and rebase.
- Conflict or blocked results get an **Analyze with AIA** button. AIA reads the state and explains how to resolve it without changing files.`,
};
