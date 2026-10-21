import fs from "node:fs";
import path from "node:path";

/**
 * 백엔드 자손이 시스템 브라우저를 열지 못하게 PATH 앞에 세우는 `open` 대체. 임시 HOME에는
 * 로그인 토큰이 없어 공급자 CLI가 OAuth로 넘어갈 수 있다. 호출은 막고 인자만 기록한다.
 */
export function writeOpenShim(binDir, logPath) {
  const shim = path.join(binDir, "open");
  // G9: JSON 문자열의 큰따옴표는 셸의 $()·백틱을 실행한다. 경로 전체를 셸 리터럴로 쓴다.
  const quotedLogPath = "'" + logPath.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(shim, `#!/bin/sh
printf '%s\\n' "$*" >> ${quotedLogPath}
exit 0
`, { mode: 0o755 });
}
