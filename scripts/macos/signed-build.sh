#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h}"
identity="${AGENT_MANAGER_CODESIGN_IDENTITY:-Agent Manager Local Development}"
profile="release"

for argument in "$@"; do
  if [[ "$argument" == "--debug" ]]; then
    profile="debug"
  fi
done

"$script_dir/require-local-signing-identity.sh"

cd "$repo_dir"
export APPLE_SIGNING_IDENTITY="$identity"
npx tauri build "$@"
"$script_dir/sign-local-binary.sh" "$repo_dir/target/$profile/agent-manager-tauri"
