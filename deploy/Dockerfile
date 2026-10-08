# Container image for the game server plus the web bundle (design §11, ADR-0011). Build context: the repository root.
#
#   docker build -f deploy/Dockerfile --build-arg HEXLANDS_BUILD_VERSION=<git sha> .
#
# HEXLANDS_BUILD_VERSION is the ONE version of the artefact (design D12). It is baked into the web bundle (and its
# dist/version.txt) and becomes the server's buildVersion (/healthz version, room.buildVersion) and OTel service.version.

FROM node:22-bookworm-slim AS build
ARG HEXLANDS_BUILD_VERSION
RUN test -n "$HEXLANDS_BUILD_VERSION" || (echo "HEXLANDS_BUILD_VERSION (the git SHA) is required" >&2 && exit 1)
# Compilers only for the native better-sqlite3 build when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /src
COPY . .
# One layer: install, build the web bundle and the server bundle with the same version, refuse any test code in the
# shipped artefacts (O2-3b), then produce the server's production node_modules (only better-sqlite3 is loaded at
# runtime; everything else is bundled) and an empty /data owned by the runtime user.
RUN pnpm install --frozen-lockfile \
 && HEXLANDS_BUILD_VERSION="$HEXLANDS_BUILD_VERSION" pnpm --filter @hexlands/web build \
 && pnpm --filter @hexlands/server bundle \
 && test "$(cat apps/web/dist/version.txt)" = "$HEXLANDS_BUILD_VERSION" \
 && if grep -rlE "engine/testing|server/testing|__fixtures__|\.test\.tsx?" apps/server/dist apps/web/dist; then \
      echo "test code found in the build output" >&2; exit 1; fi \
 && pnpm --filter @hexlands/server deploy --prod /out \
 && mkdir -p /out/data

FROM node:22-bookworm-slim AS runtime
ARG HEXLANDS_BUILD_VERSION
ENV NODE_ENV=production \
    HEXLANDS_ENV=prod \
    HEXLANDS_TELEMETRY=otlp \
    HEXLANDS_PORT=8080 \
    HEXLANDS_DB_PATH=/data/hexlands.db \
    HEXLANDS_STATIC_DIR=/app/web \
    HEXLANDS_BUILD_VERSION=${HEXLANDS_BUILD_VERSION}
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /src/apps/server/dist/main.mjs ./main.mjs
COPY --from=build --chown=node:node /src/apps/web/dist ./web
COPY --from=build --chown=node:node /out/data /data
VOLUME /data
USER node
# No EXPOSE: the app port is reachable only on the compose network, through Caddy (design D11).
STOPSIGNAL SIGTERM
CMD ["node", "main.mjs"]
