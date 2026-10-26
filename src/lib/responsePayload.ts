/**
 * 백엔드 응답 본문을 JSON으로 읽는다. 본문이 비었거나 JSON이 아니면 null이다 — 오류
 * 응답은 문구 없이 상태 코드만 줄 수 있고, 그때 부르는 쪽이 기본 문구로 떨어진다.
 *
 * 단 **제한시간 중단은 null이 아니다.** 헤더가 온 뒤 본문을 읽는 사이에 신호가 끊기면
 * `json()`은 중단 오류로 거절되는데, 그것까지 null로 삼키면 시간 초과가 "본문 없는
 * 성공"이 된다 — 명령 POST는 `null`을 성공 값으로 돌려주고, 접근 상태 조회는 버전이
 * 없는 응답으로 읽어 "API 버전이 호환되지 않습니다"라는 엉뚱한 원인을 띄웠다. 그래서
 * 신호가 끊긴 경우에는 원래 오류를 다시 던지고, 무엇으로 알릴지는 호출부가 정한다.
 */
export async function readJsonPayload<T>(response: Response, signal?: AbortSignal): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return null;
  }
}

/** 본문을 받는 동안의 진행. `total`은 전체 크기를 믿을 수 있을 때만 있다. */
export interface DownloadProgress {
  loaded: number;
  total: number | null;
}

/**
 * 받은 바이트 수와 전체 크기로 0~1 비율을 낸다. 전체 크기를 모르면 null이다 — 그때 화면은
 * 실제 비율 대신 흘러가는 막대를 보인다.
 */
export function downloadRatio(progress: DownloadProgress | null): number | null {
  if (!progress || !progress.total) return null;
  return Math.min(1, progress.loaded / progress.total);
}

/**
 * 응답 헤더에서 본문의 전체 크기(풀린 바이트 기준)를 읽는다. 백엔드는 압축할 때 압축 전 크기를
 * `X-Uncompressed-Length`로 싣는다 — 압축하면 Content-Length는 압축된 크기인데 읽는 스트림은
 * 풀린 바이트라 비율이 1을 넘는다. 그 헤더가 없는 압축 응답이면 모른다고 답한다.
 */
export function responseBodyTotal(headers: Headers): number | null {
  const declared = (value: string | null) => {
    const length = Number(value);
    return value !== null && Number.isFinite(length) && length > 0 ? length : null;
  };
  const uncompressed = declared(headers.get("x-uncompressed-length"));
  if (uncompressed !== null) return uncompressed;
  return headers.get("content-encoding") ? null : declared(headers.get("content-length"));
}

/**
 * `readJsonPayload`와 같되 본문을 조각으로 받으며 받은 만큼을 알린다. 큰 세션 원문은 원격
 * 연결에서 받는 데만 몇 초가 걸려, 화면이 실제로 얼마나 받았는지를 보일 수 있게 한다.
 * 스트림을 읽을 수 없는 환경이면 그냥 한 번에 읽는다. 실패·중단의 뜻은 `readJsonPayload`와 같다.
 */
export async function readJsonPayloadWithProgress<T>(
  response: Response,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<T | null> {
  const reader = response.body?.getReader();
  if (!reader) return readJsonPayload<T>(response, signal);
  // 받은 양이 알린 크기를 넘으면 그 크기는 믿을 수 없다(데스크톱 창은 다른 출처라 압축 여부를
  // 못 읽고 압축된 Content-Length만 볼 수 있다). 그때부터는 모른다고 알린다.
  let total = responseBodyTotal(response.headers);
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    onProgress({ loaded, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      if (total !== null && loaded > total) total = null;
      onProgress({ loaded, total });
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return null;
  }
}
