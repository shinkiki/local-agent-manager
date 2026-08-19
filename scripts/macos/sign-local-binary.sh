#!/bin/zsh
set -euo pipefail

identity="${AGENT_MANAGER_CODESIGN_IDENTITY:-Agent Manager Local Development}"
identifier="${AGENT_MANAGER_CODESIGN_IDENTIFIER:-com.shinc.agentmanager}"
script_dir="${0:A:h}"

"$script_dir/require-local-signing-identity.sh"

if (( $# != 1 )); then
  print -u2 "사용법: $0 /absolute/path/to/binary"
  exit 1
fi

binary="$1"
if [[ ! -f "$binary" || ! -x "$binary" ]]; then
  print -u2 "서명할 실행 파일을 찾을 수 없습니다: $binary"
  exit 1
fi

/usr/bin/codesign \
  --force \
  --sign "$identity" \
  --identifier "$identifier" \
  --timestamp=none \
  "$binary"
/usr/bin/codesign --verify --strict "$binary"
