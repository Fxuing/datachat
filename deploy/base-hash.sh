#!/usr/bin/env sh
set -eu

# Deterministic tag for datachat-server-base derived from all files that affect
# @datachat/server production dependencies.
FILES="
deploy/Dockerfile.base
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
apps/server/package.json
apps/web/package.json
packages/datasource-sdk/package.json
packages/shared/package.json
"

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -c1-12
  else
    shasum -a 256 | cut -c1-12
  fi
}

{
  for f in $FILES; do
    printf '=== %s ===\n' "$f"
    tr -d '\r' < "$f"
    printf '\n'
  done
} | hash_stdin | sed 's/^/deps-/'
