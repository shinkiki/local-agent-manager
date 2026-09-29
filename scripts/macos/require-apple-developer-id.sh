#!/bin/zsh
# Developer ID Application 서명 신원을 확인하고 이름을 stdout으로 출력한다.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Apple Developer ID 서명은 macOS에서만 사용할 수 있습니다."
  exit 1
fi

if [[ -n "${AGENT_MANAGER_APPLE_SIGNING_IDENTITY:-}" ]]; then
  identity="$AGENT_MANAGER_APPLE_SIGNING_IDENTITY"
  if ! /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -Fq "\"$identity\""; then
    print -u2 "지정한 서명 신원 '$identity'를 로그인 Keychain에서 찾을 수 없습니다."
    exit 1
  fi
  print -r -- "$identity"
  exit 0
fi

# find-identity 출력 형식: `  1) <해시> "Developer ID Application: 이름 (TEAMID)"`
typeset -a matches
matches=("${(@f)$(/usr/bin/security find-identity -v -p codesigning \
  | /usr/bin/sed -n 's/^.*"\(Developer ID Application: [^"]*\)".*$/\1/p')}")
matches=("${(@)matches:#}")

if (( ${#matches} == 0 )); then
  print -u2 "Developer ID Application 인증서를 찾을 수 없습니다."
  print -u2 "scripts/macos/APPLE_RELEASE_SIGNING.md의 최초 설정 절차를 완료하세요."
  exit 1
fi

if (( ${#matches} > 1 )); then
  print -u2 "Developer ID Application 인증서가 여러 개입니다. AGENT_MANAGER_APPLE_SIGNING_IDENTITY로 하나를 지정하세요."
  for entry in "${matches[@]}"; do
    print -u2 "  - $entry"
  done
  exit 1
fi

print -r -- "${matches[1]}"
