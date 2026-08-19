#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"

if (( $# < 1 )); then
  print -u2 "Tauri 개발 실행 파일 경로가 전달되지 않았습니다."
  exit 1
fi

binary="$1"
shift
"$script_dir/sign-local-binary.sh" "$binary"
exec "$binary" "$@"

