FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SIM_EVAL_CONFIG_SOURCE=file \
    SIM_EVAL_DATA_ROOT=/data \
    PORT=5260 \
    HOST=0.0.0.0 \
    HOME=/home/node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/config ./config
COPY --from=build /app/.cursor/skills ./.cursor/skills
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/config \
    && chown -R node:node /data
USER node
EXPOSE 5260
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "server/main.ts"]
