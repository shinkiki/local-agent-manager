/**
 * 새 배포판이 올라왔는지 확인하는 모듈. 공개 저장소의 manifest 한 장을 읽어 지금 실행 중인
 * 버전과 견주고, 사용자가 "이 버전은 그만 알리기"를 누른 것과 마지막 확인 시각만 로컬
 * 저장소에 남긴다.
 *
 * 조회 실패는 앱 사용을 막지 않는다. 버전 확인은 부가 기능이고, 네트워크가 끊겼다고 실행
 * 중인 앱에 오류를 띄울 이유가 없다. 그래서 이 모듈의 실패는 모두 "최신 버전을 모른다"로
 * 수렴한다 — 예외를 밖으로 내보내지 않고 manifest를 비운 채 돌려준다.
 *
 * 저장소가 막힌 환경(쿠키 전면 차단·사생활 보호 모드·용량 초과)을 받아 넘기는 일은
 * `storedText`가 한 벌로 맡는다. 여기서 다시 try/catch로 감싸면 그 규칙이 두 벌이 되고,
 * 한쪽만 고쳐질 때 버전 확인 하나 때문에 앱 셸이 오류 경계로 떨어질 수 있다.
 */
import { readStoredText, writeStoredText } from "./storedText.ts";

export interface AppVersionManifest {
  latestVersion: string;
  releasedAt: string | null;
  releaseNotes: string;
  downloadUrl: string;
}

/**
 * 버전 확인 한 번의 결과. 알아낸 manifest만 담는다 — 실패 사유와 확인 시각을 함께
 * 돌려주던 때가 있었지만 화면은 manifest만 보고, 실패 사유 자리에는 어느 경로로 끝나도
 * 늘 null이 들어가 있어 "실패하지 않았다"로 읽혔다. 마지막 확인 시각은 저장소에
 * 남으므로 필요한 곳이 `lastAppVersionCheckAt`으로 읽는다.
 */
export interface AppUpdateState {
  manifest: AppVersionManifest | null;
}

declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;
const APP_VERSION_MANIFEST_URL = "https://raw.githubusercontent.com/shinkiki/local-agent-manager/main/updates/agent-manager.json";
const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const STORAGE_KEY = "agent-manager.app-update.v1";

/** manifest가 실어 보낸 버전 문자열이 지켜야 하는 모양. `1.2`~`1.2.3.4`에 사전 표기 꼬리를 허용한다. */
const MANIFEST_VERSION_PATTERN = /^\d+(\.\d+){1,3}([+-][0-9A-Za-z.-]+)?$/;
/** 내려받기 주소는 HTTPS만 받는다. 공개 저장소에서 읽은 값을 그대로 열기 때문이다. */
const DOWNLOAD_URL_PATTERN = /^https:\/\//;

interface StoredUpdateState {
  lastCheckedAt: number | null;
  hiddenVersion: string | null;
}

/**
 * 저장해 둔 항목. 저장값이 없는 것과 형식이 깨진 것은 같은 뜻으로 본다 — 버전 확인은
 * 부가 기능이라, 남은 찌꺼기 때문에 조회 주기나 숨긴 버전을 잃는 편이 낫다.
 */
function loadStored(): StoredUpdateState {
  const parsed = parseStored(readStoredText(STORAGE_KEY));
  return {
    lastCheckedAt: typeof parsed?.lastCheckedAt === "number" ? parsed.lastCheckedAt : null,
    hiddenVersion: typeof parsed?.hiddenVersion === "string" ? parsed.hiddenVersion : null,
  };
}

function parseStored(value: string | null): Partial<StoredUpdateState> | null {
  try {
    return JSON.parse(value ?? "null") as Partial<StoredUpdateState> | null;
  } catch {
    return null;
  }
}

/**
 * 저장된 항목 중 하나만 바꾼다. 항목을 하나 고칠 때마다 나머지를 다시 읽어 펼쳐 넣는
 * 손걸음(`save({ ...load(), 한 항목 })`)이 두 벌 있었고, 항목이 늘면 그 자리마다 새
 * 항목을 빠뜨릴 수 있어 여기 한 벌만 둔다.
 *
 * 남기지 못한 저장은 `storedText`가 조용히 삼킨다. 다음 실행이 확인을 한 번 더 하고
 * 숨긴 버전이 다시 보일 뿐이다.
 */
function updateStored(patch: Partial<StoredUpdateState>): void {
  writeStoredText(STORAGE_KEY, JSON.stringify({ ...loadStored(), ...patch }));
}

/**
 * 버전 문자열을 자리마다 정수로 푼다. 숫자로 읽히지 않는 자리(사전 표기 꼬리 등)는 0으로
 * 본다 — manifest 형식 검사를 통과한 값만 들어오므로 여기서 다시 거절하지 않는다.
 */
function versionParts(value: string): number[] {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** 자리 수가 다른 두 버전은 없는 자리를 0으로 채워 견준다(`1.2`와 `1.2.0`은 같다). */
function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * manifest의 문자열 항목. 문자열이 아니면 `null`이다. 없는 항목과 빈 문자열을 가르는 것은
 * 호출부의 몫이라 여기서 기본값으로 메우지 않는다 — 표시 여부를 빈 문자열로 판단하는
 * 항목(`releasedAt`)이 있어, 한쪽으로 뭉개면 화면에 빈 줄이 생기거나 사라진다.
 */
function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/**
 * 읽어 온 manifest를 쓸 수 있는 모양으로 확인한다. 공개 저장소의 파일이라 형식이 어긋나면
 * 쓰지 않고 버리는 쪽이 맞다 — 반쯤 채워진 값으로 최신 버전을 판단하거나 엉뚱한 주소를
 * 열어서는 안 된다. 던진 예외는 `checkAppVersion`이 받아 "모른다"로 바꾼다.
 */
function normalizeManifest(value: unknown): AppVersionManifest {
  if (!value || typeof value !== "object") throw new Error("버전 manifest 형식이 올바르지 않습니다.");
  const source = value as Record<string, unknown>;
  const latestVersion = stringField(source, "latestVersion")?.trim() ?? "";
  const downloadUrl = stringField(source, "downloadUrl")?.trim() ?? "";
  if (!MANIFEST_VERSION_PATTERN.test(latestVersion)) throw new Error("최신 버전 형식이 올바르지 않습니다.");
  if (!DOWNLOAD_URL_PATTERN.test(downloadUrl)) throw new Error("다운로드 주소는 HTTPS여야 합니다.");
  return {
    latestVersion,
    releasedAt: stringField(source, "releasedAt"),
    releaseNotes: stringField(source, "releaseNotes") ?? "",
    downloadUrl,
  };
}

export function shouldCheckAppVersion(now = Date.now()): boolean {
  const { lastCheckedAt } = loadStored();
  return lastCheckedAt === null || now - lastCheckedAt >= APP_UPDATE_CHECK_INTERVAL_MS;
}

export function isNewerAppVersion(version: string): boolean {
  return compareVersions(version, APP_VERSION) > 0;
}

export function isAppVersionHidden(version: string): boolean {
  return loadStored().hiddenVersion === version;
}

export function hideAppVersion(version: string): void {
  updateStored({ hiddenVersion: version });
}

export function lastAppVersionCheckAt(): number | null {
  return loadStored().lastCheckedAt;
}

export async function checkAppVersion(): Promise<AppUpdateState> {
  const checkedAt = Date.now();
  try {
    const response = await fetch(APP_VERSION_MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = normalizeManifest(await response.json());
    // 성공한 확인만 시각을 남긴다. 실패를 확인으로 세면 네트워크가 끊긴 동안 주기가
    // 헛돌아, 연결이 돌아온 뒤에도 다음 주기까지 새 버전을 알아채지 못한다.
    updateStored({ lastCheckedAt: checkedAt });
    return { manifest };
  } catch {
    return { manifest: null };
  }
}
