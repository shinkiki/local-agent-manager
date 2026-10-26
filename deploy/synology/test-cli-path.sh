#!/bin/sh
# V2/H11: 로그인 셸은 PATH에 이미 있는 사용자 CLI도 다른 설치보다 먼저 찾아야 한다.
# Docker 없이 실제 profile.d 파일을 읽어 우선순위와 반복 로딩을 확인한다.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

check_path() (
  label=$1
  PATH=$2
  expected=$3
  . "$here/agent-manager-cli-path.sh"
  if [ "$PATH" != "$expected" ]; then
    printf 'FAIL V2/H11 %s: PATH=%s (expected %s)\n' "$label" "$PATH" "$expected" >&2
    exit 1
  fi
  # 재로딩은 사용자 bin을 계속 더하지 않아야 한다.
  . "$here/agent-manager-cli-path.sh"
  if [ "$PATH" != "$expected" ]; then
    printf 'FAIL V2/H11 %s: repeated sourcing changed PATH\n' "$label" >&2
    exit 1
  fi
)

check_path missing '/usr/local/bin:/usr/bin' "$HOME/.local/bin:/usr/local/bin:/usr/bin"
check_path first "$HOME/.local/bin:/usr/bin" "$HOME/.local/bin:/usr/bin"
check_path only "$HOME/.local/bin" "$HOME/.local/bin"
check_path last "/usr/local/bin:/usr/bin:$HOME/.local/bin" "$HOME/.local/bin:/usr/local/bin:/usr/bin:$HOME/.local/bin"
check_path middle "/usr/local/bin:$HOME/.local/bin:/usr/bin" "$HOME/.local/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin"
check_path similar "$HOME/.local/bin-old:/usr/bin" "$HOME/.local/bin:$HOME/.local/bin-old:/usr/bin"
check_path empty '' "$HOME/.local/bin:"
check_path empty_segment ":/usr/bin::$HOME/.local/bin:" "$HOME/.local/bin::/usr/bin::$HOME/.local/bin:"
printf 'V2/H11: 8 PATH cases passed\n'
