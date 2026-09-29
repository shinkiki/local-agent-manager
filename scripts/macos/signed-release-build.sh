#!/bin/zsh
# Developer ID 서명 + 공증 + staple 까지 끝낸 배포용 macOS 번들을 만든다.
# 개발용 자체서명 경로(signed-build.sh)와는 별개다.
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h}"
env_file="${AGENT_MANAGER_APPLE_ENV_FILE:-$HOME/.config/agent-manager/apple-signing.env}"

if [[ -f "$env_file" ]]; then
  set -a
  source "$env_file"
  set +a
fi

identity="$("$script_dir/require-apple-developer-id.sh")"

notarize=1
typeset -a notary_args
notary_args=()
if [[ "${AGENT_MANAGER_SKIP_NOTARIZATION:-0}" == "1" ]]; then
  notarize=0
  print -u2 "경고: 공증을 건너뜁니다. 이 산출물은 배포하지 마세요."
elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
    print -u2 "APPLE_API_KEY_PATH가 가리키는 .p8 파일이 없습니다."
    exit 1
  fi
  notary_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  print -u2 "공증 자격증명이 없습니다. 다음 중 한 벌을 $env_file 또는 환경 변수로 제공하세요."
  print -u2 "  1) APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH"
  print -u2 "  2) APPLE_ID, APPLE_PASSWORD(앱 암호), APPLE_TEAM_ID"
  print -u2 "자세한 절차는 scripts/macos/APPLE_RELEASE_SIGNING.md에 있습니다."
  exit 1
fi

cd "$repo_dir"
export APPLE_SIGNING_IDENTITY="$identity"

npx tauri build --config src-tauri/tauri.macos-signing.conf.json "$@"

bundle_dir="$repo_dir/target/release/bundle"
app_path="$bundle_dir/macos/Agent Manager.app"
typeset -a dmgs
dmgs=("$bundle_dir"/dmg/*.dmg(N))

# --bundles dmg로 만들면 Tauri가 DMG를 만든 뒤 .app을 지운다. 둘 중 남아 있는
# 산출물을 검증한다.
if [[ ! -d "$app_path" ]] && (( ${#dmgs} == 0 )); then
  print -u2 "검증할 산출물을 찾을 수 없습니다: $bundle_dir"
  exit 1
fi

verify_app() {
  local target="$1"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$target"
  if (( notarize )); then
    # spctl은 공증 티켓까지 요구하므로 공증을 건넌 산출물에는 적용하지 않는다.
    /usr/sbin/spctl --assess --type exec --verbose=4 "$target"
    /usr/bin/xcrun stapler validate "$target"
  fi
}

if [[ -d "$app_path" ]]; then
  verify_app "$app_path"
fi

for dmg in "${dmgs[@]}"; do
  if (( notarize )); then
    # Tauri는 앱에만 staple하고 DMG는 서명만 한다. 내려받은 DMG 자체가
    # 오프라인에서도 통과하도록 DMG도 공증해 staple한다.
    if ! /usr/bin/xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      /usr/bin/xcrun stapler staple "$dmg" >/dev/null 2>&1 \
        || /usr/bin/xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait
      /usr/bin/xcrun stapler staple "$dmg"
    fi
    /usr/bin/xcrun stapler validate "$dmg"
  fi
  /usr/bin/codesign --verify --verbose=2 "$dmg"

  # DMG 안의 앱이 실제로 Gatekeeper를 통과하는지 마운트해 확인한다.
  mount_point="$(/usr/bin/hdiutil attach -nobrowse -readonly -mountrandom /tmp "$dmg" \
    | /usr/bin/awk -F'\t' '/\/tmp\//{print $NF}' | /usr/bin/tail -1)"
  if [[ -z "$mount_point" ]]; then
    print -u2 "DMG를 마운트하지 못했습니다: $dmg"
    exit 1
  fi
  {
    typeset -a mounted_apps
    mounted_apps=("$mount_point"/*.app(N))
    if (( ${#mounted_apps} == 0 )); then
      print -u2 "DMG 안에서 앱 번들을 찾지 못했습니다: $dmg"
      exit 1
    fi
    verify_app "${mounted_apps[1]}"
  } always {
    # 이 DMG로 만든 마운트만 분리한다. 검증 직후에는 잠깐 사용 중일 수 있어
    # 몇 번 다시 시도하고, 그래도 남으면 조용히 넘기지 않고 알린다.
    for attempt in 1 2 3; do
      /usr/bin/hdiutil detach "$mount_point" -quiet && break
      sleep 2
      if (( attempt == 3 )); then
        print -u2 "경고: 마운트를 분리하지 못했습니다. 직접 정리하세요: hdiutil detach $mount_point"
      fi
    done
  }
  print "검증 완료: $dmg"
done

if [[ -d "$app_path" ]]; then
  print "검증 완료: $app_path"
fi
