#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h}"

"$script_dir/require-local-signing-identity.sh"
cd "$repo_dir"
cargo build --release -p agent-manager-server
"$script_dir/sign-local-binary.sh" "$repo_dir/target/release/agent-manager-server"
