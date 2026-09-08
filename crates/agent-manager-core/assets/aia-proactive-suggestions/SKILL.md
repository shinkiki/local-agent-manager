---
name: aia-proactive-suggestions
description: AIA가 앱 상태를 바탕으로 안전한 선제 제안을 만드는 선언형 규칙 모음
---

# AIA 선제 제안 팩

`references/aia-suggestions.json`에서 제안 문구, 명령 초안, 임계값과 재알림 정책을 관리합니다.

- 앱이 지원하는 `kind`, 파라미터와 템플릿 변수만 사용합니다.
- 셸, JavaScript, URL, 도구 호출이나 승인 우회 지침을 추가하지 않습니다.
- 제안 명령은 사용자 검토용 초안이며 자동 실행이나 자동 전송을 요구하지 않습니다.
- `skillContentChanged`는 공통 스킬 원본의 내용 지문이 바뀐 직후 검토를 제안하는 즉시 트리거입니다. `expiresHours`(기본 24)가 지나면 스스로 사라지고, `maxResults`(기본 3)로 한 번에 뜰 개수를 제한합니다.
- 변경 후 Skills 화면의 검증 결과를 확인합니다. 잘못된 업데이트는 마지막 정상 팩으로 대체됩니다.
