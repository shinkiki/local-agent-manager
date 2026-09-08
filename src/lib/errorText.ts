/**
 * 예외를 화면에 그대로 띄울 한 줄 문자열로 바꾼다.
 *
 * `errorText`·`errorMessage`·`message`라는 세 이름으로 같은 한 줄이 화면 컴포넌트와
 * `lib` 모듈에 열일곱 벌 흩어져 있었다. 이름이 달라 같은 것인지 읽어야만 알 수 있었고,
 * `Error`가 아닌 값을 어떻게 보여 주는지도 파일마다 확인해야 했다. 판정만 여기 모으고,
 * `Error`가 아닌 값에 무엇을 보여 줄지는 그 자리의 뜻을 아는 호출부가 `fallback`으로
 * 계속 정한다.
 */
export function errorText(cause: unknown, fallback?: string): string {
  if (cause instanceof Error) return cause.message;
  return fallback ?? String(cause);
}
