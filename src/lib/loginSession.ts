/**
 * C20. 접근 채널 로그인의 화면 쪽 상태 — 세션 토큰 하나와 "지금 로그인이 필요하다"는 신호.
 *
 * 토큰은 백엔드가 `/api/login`에서 발급한 불투명 값이다. 메모리에 들고 `localStorage`에
 * 같은 값을 두어 새로고침·앱 재시작 뒤에도 이어진다. 쿠키를 쓰지 않는 이유는 Tauri 창의
 * 페이지(`tauri://localhost`)에서 127.0.0.1로 가는 요청이 교차 출처라 WKWebView가 쿠키를
 * 믿을 만하게 실어 주지 않기 때문이다 — 대신 `fetch`는 헤더로, WebSocket과 `<img>`는 쿼리로
 * 같은 값을 싣는다(`backend.ts`·`ipcTransport.ts`).
 *
 * "로그인 필요" 신호는 두 곳에서 온다. 악수(`/api/access`)가 `authenticated:false`에 요구를
 * 실어 오거나, 어느 요청이든 401 `LOGIN_REQUIRED`로 거절될 때다. 둘 다 여기로 모여
 * `LoginGate`가 구독한다.
 */

const STORAGE_KEY = "agentManager.loginSession";

export interface LoginRequirement {
  password: boolean;
  otp: boolean;
}

export const NO_LOGIN_REQUIREMENT: LoginRequirement = { password: false, otp: false };

export function loginRequirementAny(requirement: LoginRequirement | null | undefined): boolean {
  return Boolean(requirement && (requirement.password || requirement.otp));
}

let memoryToken: string | null | undefined;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 지금 들고 있는 세션 토큰. 없으면 null. */
export function loginSessionToken(): string | null {
  if (memoryToken === undefined) {
    const stored = storage()?.getItem(STORAGE_KEY) ?? null;
    memoryToken = stored && stored.length > 0 ? stored : null;
  }
  return memoryToken;
}

/** 토큰을 바꾼다. null이면 지운다(로그아웃·거절). */
export function setLoginSessionToken(token: string | null): void {
  memoryToken = token && token.length > 0 ? token : null;
  const store = storage();
  if (!store) return;
  try {
    if (memoryToken) store.setItem(STORAGE_KEY, memoryToken);
    else store.removeItem(STORAGE_KEY);
  } catch {
    // 저장소를 못 써도(사생활 모드) 메모리 토큰으로 이 탭은 이어진다.
  }
}

/** 요청 헤더에 실을 토큰. 없으면 빈 객체라 그대로 펼쳐 넣을 수 있다. */
export function loginSessionHeaders(): Record<string, string> {
  const token = loginSessionToken();
  return token ? { "X-Agent-Manager-Session": token } : {};
}

/** 어느 요청이 401 `LOGIN_REQUIRED`로 거절됐을 때 던지는 오류. 게이트가 이미 화면을 바꿨다. */
export class LoginRequiredError extends Error {
  readonly requirement: LoginRequirement;

  constructor(requirement: LoginRequirement, message: string) {
    super(message);
    this.name = "LoginRequiredError";
    this.requirement = requirement;
  }
}

type Listener = () => void;

let required: LoginRequirement | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * "지금 로그인 화면을 띄워야 한다"는 상태. `useSyncExternalStore`로 구독한다.
 * 값이 있으면 그 요구(비밀번호·OTP 중 무엇)를 담고, null이면 로그인이 필요 없다.
 */
export const loginRequiredStore = {
  get(): LoginRequirement | null {
    return required;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** 거절을 받았을 때. 이미 같은 요구가 떠 있으면 다시 알리지 않는다. */
  raise(requirement: LoginRequirement): void {
    if (required && required.password === requirement.password && required.otp === requirement.otp) return;
    required = { password: requirement.password, otp: requirement.otp };
    notify();
  },
  clear(): void {
    if (required === null) return;
    required = null;
    notify();
  },
};

/** 401 `LOGIN_REQUIRED` 응답의 `params`에서 요구를 읽는다. 값은 백엔드가 "true"/"false"로 보낸다. */
export function loginRequirementFromParams(params: Record<string, string> | undefined): LoginRequirement {
  return {
    password: params?.password === "true",
    otp: params?.otp === "true",
  };
}
