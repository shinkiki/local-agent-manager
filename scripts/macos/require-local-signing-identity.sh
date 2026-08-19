#!/bin/zsh
set -euo pipefail

identity="${AGENT_MANAGER_CODESIGN_IDENTITY:-Agent Manager Local Development}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "로컬 Agent Manager 코드서명은 macOS에서만 사용할 수 있습니다."
  exit 1
fi

if ! /usr/bin/security find-identity -v -p codesigning \
  | /usr/bin/grep -Fq "\"$identity\""; then
  print -u2 "코드서명 인증서 '$identity'를 찾을 수 없습니다."
  print -u2 "scripts/macos/LOCAL_CODE_SIGNING.md의 최초 설정 절차를 완료하세요."
  exit 1
fi

