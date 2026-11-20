#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/.local/cargo-target}"
mkdir -p "$PWD/.local/tmp"
export TMPDIR="$PWD/.local/tmp"
export npm_config_cache="$PWD/.local/npm-cache"

if ! command -v node >/dev/null || ! node --eval "process.exit(Number(process.versions.node.split('.')[0]) >= 26 ? 0 : 1)" || ! command -v cargo >/dev/null; then
  echo 'Node.js 26+, Rust stable and Xcode command line tools are required. See README.md.'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm exec --yes --package=pnpm@11.3.0 -- pnpm install --frozen-lockfile
fi
exec npm exec --yes --package=pnpm@11.3.0 -- pnpm dev
