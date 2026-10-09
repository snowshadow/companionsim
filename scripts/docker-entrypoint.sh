#!/bin/sh
# 首次启动写出平台配置，再交给应用进程。本地 npm run dev 不走这里。
set -eu
cd /app
node --import tsx server/prepare-platform-config.ts
if [ "$#" -eq 0 ]; then
  set -- node --import tsx server/main.ts
fi
exec "$@"
