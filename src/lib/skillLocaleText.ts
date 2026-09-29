/**
 * 스킬관리 lib 모듈들이 함께 쓰는 로케일 짝 어휘.
 *
 * 문구를 만드는 자리는 성격이 갈린다 — 저장 폼의 입력 검증(`skillLibraryInput`)과 목록·칩의
 * 표시 문구(`skillLibrary`)는 서로 읽을 것이 없다. 다만 둘 다 React 바깥이라 로케일을 모르고
 * 컴포넌트의 `text(ko, en)`을 받아 조합만 하며, 그 서명과 짝의 모양은 같아야 한다.
 *
 * 그 어휘를 어느 한쪽에 얹으면 갈라 둔 두 모듈 사이에 방향 없는 의존이 생긴다. 함께 쓰는
 * 것만 따로 두어(창 라벨 문법을 `usageWindowLabel`에 둔 것과 같은 요령) 양쪽이 나란히
 * 빌려 쓰게 한다.
 */

/** 한국어·영어 짝에서 지금 로케일의 문구를 고르는 컴포넌트의 `text`. */
export type Translate = (ko: string, en: string) => string;

/** 로케일 짝 한 벌. `translate(...pair)`로 그대로 펼쳐 쓴다. */
export type LabelText = readonly [ko: string, en: string];
