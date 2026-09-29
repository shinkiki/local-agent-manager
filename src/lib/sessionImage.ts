import type { ProviderId } from "../types";

/** 세션 기록 안에서 이미지 한 장을 가리키는 위치입니다. */
export interface TranscriptImageRef {
  sourceOffset: number;
  sourcePointer: string;
}

/** 백엔드 경로에 들어갈 값을 서로 섞이지 않는 URL 조각 한 벌로 직렬화한다. */
function encodePathSegments(segments: readonly (string | number)[]): string {
  return segments.map((segment) => encodeURIComponent(String(segment))).join("/");
}

/**
 * 기록 이미지를 내려주는 백엔드 경로입니다.
 *
 * 이미지는 대화 기록 줄 안에 base64로 박혀 있어 목록 응답에 담기에는 너무 큽니다.
 * 그래서 목록에는 줄 오프셋과 JSON 포인터만 담고, 화면이 실제로 그릴 때 이 경로로
 * 원본 바이트만 따로 읽습니다. JSON 포인터의 슬래시는 한 경로 조각으로 인코딩합니다.
 */
export function sessionTranscriptImagePath(
  source: ProviderId,
  sessionId: string,
  image: TranscriptImageRef,
): string {
  const offset = Math.max(0, Math.trunc(image.sourceOffset));
  return `/api/session-image/${encodePathSegments([
    source,
    sessionId,
    offset,
    image.sourcePointer,
  ])}`;
}
