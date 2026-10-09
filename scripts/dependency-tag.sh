#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node_image=${NODE_BASE_IMAGE:-node:24.18.0-bookworm-slim}
# No OS-specific node_modules: dependencies are always installed inside Linux.
if command -v sha256sum >/dev/null 2>&1; then
  dep_hash=$({ cat Dockerfile.base package.json package-lock.json; printf '%s\n' "$node_image"; } | sha256sum | cut -c1-20)
else
  dep_hash=$({ cat Dockerfile.base package.json package-lock.json; printf '%s\n' "$node_image"; } | shasum -a 256 | cut -c1-20)
fi
printf 'deps-%s\n' "$dep_hash"
