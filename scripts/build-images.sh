#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
repository=${IMAGE_REPOSITORY:-sim-eval-ui}
platform=${BUILD_PLATFORM:-linux/amd64}
node_image=${NODE_BASE_IMAGE:-node:24.18.0-bookworm-slim}
base_image="$repository:$(NODE_BASE_IMAGE="$node_image" sh scripts/dependency-tag.sh)-$(printf '%s' "$platform" | tr / -)"
app_image="$repository:${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
if [ "${REBUILD_DEPS:-false}" = true ] || ! docker image inspect "$base_image" >/dev/null 2>&1; then
  docker build --platform "$platform" --build-arg "NODE_BASE_IMAGE=$node_image" -f Dockerfile.base -t "$base_image" .
fi
docker build --platform "$platform" --build-arg "DEPS_IMAGE=$base_image" -t "$app_image" .
printf 'Dependency image: %s\nApplication image: %s\n' "$base_image" "$app_image"
