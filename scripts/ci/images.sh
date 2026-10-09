#!/bin/sh
set -eu
umask 077
cd "${CI_PROJECT_DIR:?}"
: "${ACR_REGISTRY:?}" "${ACR_USERNAME:?}" "${ACR_PASSWORD:?}"
: "${SIM_EVAL_IMAGE_REPOSITORY:?}" "${CI_COMMIT_SHA:?}"
mkdir -p /kaniko/.docker
registry_auth=$(printf '%s:%s' "$ACR_USERNAME" "$ACR_PASSWORD" | base64 | tr -d '\n')
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$ACR_REGISTRY" "$registry_auth" > /kaniko/.docker/config.json
unset registry_auth
trap 'rm -f /kaniko/.docker/config.json 2>/dev/null || true' EXIT HUP INT TERM
case "${1:-}" in
  base)
    tag=$(sh scripts/dependency-tag.sh)
    /kaniko/executor --context "$CI_PROJECT_DIR" --dockerfile Dockerfile.base \
      --destination "$SIM_EVAL_IMAGE_REPOSITORY:$tag-linux-amd64" \
      --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE:-node:24.18.0-bookworm-slim}" \
      --cache=true --cache-ttl=720h --cache-repo "$SIM_EVAL_IMAGE_REPOSITORY-cache" \
      --digest-file "$CI_PROJECT_DIR/deps.digest"
    IFS= read -r dependency_digest < "$CI_PROJECT_DIR/deps.digest" || true
    printf 'DEPS_IMAGE=%s@%s\n' "$SIM_EVAL_IMAGE_REPOSITORY" "$dependency_digest" > "$CI_PROJECT_DIR/image-base.env"
    ;;
  app)
    : "${DEPS_IMAGE:?base image digest is required}"
    /kaniko/executor --context "$CI_PROJECT_DIR" --dockerfile Dockerfile \
      --destination "$SIM_EVAL_IMAGE_REPOSITORY:$CI_COMMIT_SHA" \
      --build-arg "DEPS_IMAGE=$DEPS_IMAGE" \
      --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
      --cache=true --cache-ttl=720h --cache-repo "$SIM_EVAL_IMAGE_REPOSITORY-cache" \
      --digest-file "$CI_PROJECT_DIR/image.digest"
    ;;
  *) echo 'usage: images.sh base|app' >&2; exit 2 ;;
esac
