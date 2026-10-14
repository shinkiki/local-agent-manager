# 에이전트매니저 코드리뷰 회차 — 장부 규약

레인 열 개가 동시에 돈다. **이 폴더의 규약은 전부 "같은 것을 두 번 하지 않기" 위한 것이다.**

## 무엇이 항목인가

| 종류 | 항목 id | 정체 |
| --- | --- | --- |
| 커밋 사후 리뷰 | `C-<해시 앞 12자>` | 작업브랜치에 착지한 커밋 하나 |
| 모듈 전수 리뷰 | `M-<경로 슬러그>-<지문 8자>` | `modules.json` 의 모듈 하나 |
| 결함 | `F-<파일·심볼 슬러그>-<지문 8자>` | 파일·심볼·증상으로 묶은 결함 하나 |

id 를 만드는 규칙은 `src/lib/codeReviewQueue.ts` **한 곳에만** 있다. 회차가 손으로 번호를 매기면
레인마다 다른 id 가 나와 점유가 성립하지 않는다. 슬러그 뒤의 지문은 장식이 아니다 —
`a/b.rs` 와 `a-b.rs` 는 슬러그가 같아서, 지문이 없으면 한쪽이 영영 리뷰되지 않는다.

## 파일 배치

```
docs/code-review/
  modules.json              # 전수 점검표(순서: 보안 불변식 관련 → 줄 수 많은 순)
  queue.json                # 러너가 쓴다. 센 수만 담는다. 회차 봉투가 remaining 을 읽어 띄울 레인 수를 정한다
  reviewed/<항목id>.json    # 리뷰를 마친 항목. 항목당 파일 하나
  findings/<결함id>.json    # 발견한 결함. 결함당 파일 하나
```

**한 파일에 몰아 적지 않는다.** 장부를 단일 JSON 배열로 두면 레인 열 개가 같은 줄을 고쳐
반영마다 rebase 충돌이 난다. 항목당 파일 하나면 서로 다른 파일이라 충돌이 없다.

`queue.json` 은 예외적으로 단일 파일이다. 그래서 **센 수만 담고 항목 목록은 담지 않는다** —
수천 줄짜리 목록을 레인 열 개가 회차마다 통째로 다시 쓰면 반영마다 충돌한다. 러너가 산출하는
파생값이라 충돌하면 **다시 생성해서 덮으면 된다**(`--write`). 손으로 고치지 않는다.

## 중복 방지 3중

1. **항목 점유** — 동시에 도는 레인끼리. `.rounds/.lease/items/<항목id>` 를 `mkdir` 로 잡는다
   (`parallel-round-lanes` 2절). 원자적이라 둘이 같은 순간에 잡지 못한다.
2. **장부 확인** — 지난 회차와. `reviewed/<항목id>.json` 이 있으면 큐에 오르지 않는다.
3. **반영 직전 재확인** — 내가 리뷰하는 동안 다른 레인이 같은 항목을 먼저 반영했을 수 있다.
   push 락을 잡고 rebase 한 뒤 `reviewed/<항목id>.json` 이 상대 쪽에서 들어왔으면 **내 커밋을
   버리고** `DUP-DROPPED` 로 보고한다. 억지로 밀면 같은 지적이 두 번 남는다.

결함도 같다. `findings/<결함id>.json` 이 이미 있으면 새로 만들지 말고 그 파일의
`occurrences` 에 이번 관측을 덧붙인다.

## 장부 파일의 모양

`reviewed/C-539927cbc7b5.json`

```json
{
  "itemId": "C-539927cbc7b5",
  "kind": "commit",
  "ref": "539927cbc7b5...",
  "reviewedAt": "2026-10-05T11:20:00Z",
  "lane": "L03",
  "source": "claude",
  "verdict": "결함 2건 / 수정 2건",
  "findings": ["F-chat-rs-run-turn-1a2b3c4d"],
  "commits": ["abc1234"]
}
```

`findings/F-....json`

```json
{
  "findingId": "F-chat-rs-run-turn-1a2b3c4d",
  "file": "crates/agent-manager-core/src/chat.rs",
  "symbol": "run_turn",
  "symptom": "턴 반납을 완료로 센다",
  "severity": "P2",
  "state": "fixed",
  "agentsRules": ["C7-5"],
  "occurrences": [{ "itemId": "C-539927cbc7b5", "at": "2026-10-05T11:20:00Z" }],
  "fixCommits": ["abc1234"]
}
```

파일 이름이 정체다. 본문의 `itemId` 가 파일 이름과 어긋나면 러너는 **둘 다** 리뷰된 것으로
세어 다시 집히지 않게 한다 — 규칙을 어긴 쪽을 벌주는 것보다 중복 리뷰를 막는 것이 먼저다.

## 러너

```sh
node --experimental-strip-types scripts/code-review-queue.mjs            # 요약
node --experimental-strip-types scripts/code-review-queue.mjs --json     # 큐 전체
node --experimental-strip-types scripts/code-review-queue.mjs --write    # queue.json 갱신
```

커밋은 **최신부터** 큐에 오르고 `--window` 일(기본 7)보다 오래된 미리뷰 커밋은 떨어진다.
작업브랜치에 하루 백 건 가까이 착지하므로, 오래된 것부터 돌면 새 결함을 영영 보지 못한다.
창 밖으로 밀려난 코드는 모듈 전수 리뷰가 그물로 받는다 — 그래서 두 종류를 함께 돌린다.

장부에 같은 항목이 두 번 적혀 있으면 러너는 종료 코드 1과 함께 그 id 를 찍는다.
**중복이 실제로 일어났다는 증거이므로 회차 보고에 올린다.**
