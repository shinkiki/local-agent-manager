// 영어 갤러리 표식. `releaseGalleryFixtures.ts`가 평가되기 전에 import되어야 하므로
// 영어 스펙의 첫 import로 둔다(ES 모듈은 import 순서대로 평가된다).
(globalThis as { __AM_GALLERY_LANG?: string }).__AM_GALLERY_LANG = "en";
export {};
