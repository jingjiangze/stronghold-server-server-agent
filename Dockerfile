# syntax=docker/dockerfile:1
# 卫戍协议：盟约 · production image (server + static client). Docs: docs/DEPLOY.md「Docker」.
#
# Code: GPL-3.0-or-later (LICENSE). Game art/audio is © Hypergryph / Yostar, not covered by the GPL, non-commercial use
# only (NOTICE.md), and never part of the repository. Two ways to get it into a container:
#   A) download it while building (~250 MB, needs internet during the build):
#        docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
#   B) build without it and mount the host's copy (prepared with `node tools/setup.mjs` on the host):
#        docker build -t stronghold-protocol .
#        docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
#          -v "$PWD/public/assets:/app/public/assets:ro" stronghold-protocol
#      (public/fonts, data/assets.json and data/local-assets.json are copied from the build context when present)
# Without any art the game still runs with placeholder visuals.
#
# Run:  docker run -d --name stronghold -p 3000:3000 --restart unless-stopped stronghold-protocol
# Env:  PORT (3000), HOST (0.0.0.0), SP_COMBAT (client|server), SP_VERIFY (off|sample|all), TRUST_PROXY (auto|1|0), DEBUG
#
# 这是**通用**形态：游戏进程直接对外监听 3000，没有边缘层。魔搭创空间要的
# 「nginx 占 7860 + 游戏退到 3120」拓扑在 `docker` 分支的 Dockerfile 里（那份还要 tools/deploy-ms 叠加层）。
#
# 持久卷（AI 布阵学习库）：镜像不 COPY 任何学习库内容（它是运行时产物，见 server/lineupLibrary.js），
# 所以这里挂一个**空卷**不会遮掉镜像里的任何东西 —— 想跨容器重建保留学习库就挂它：
#     -v "$PWD/lineups:/app/lineups"
# 环境变量 SP_LINEUP_LIBRARY 默认已指向该目录；不挂卷则库写在容器的可写层里，容器重建即丢。
# 部署形态的完整说明见 docs/DEPLOY.md「AI 布阵学习库」。

ARG NODE_IMAGE=node:22-alpine

# ---- 1. production dependencies (cached while package*.json are unchanged) -------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the postinstall (tools/vendor.mjs) runs in the next stage, once the sources are there
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- 2. vendor libs + optional art download ---------------------------------------------------------
FROM deps AS build
ARG FETCH_ASSETS=0
COPY shared ./shared
# NOTE (ModelScope deploy of the OFFICIAL upstream tree): the fork's offline name-moderation chain
# (deploy/stardust/auth/name-*.mjs + shared/names.js) does not exist upstream, so it is not copied here.
COPY server ./server
COPY tools ./tools
COPY data ./data
COPY public ./public
COPY docs/research ./docs/research
RUN node tools/vendor.mjs \
 && if [ "$FETCH_ASSETS" = "1" ]; then \
      node tools/fetch-assets.mjs || echo "WARNING: art download incomplete; the image falls back to placeholder art"; \
    fi \
 && rm -rf .cache

# ---- 3. runtime ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SP_LINEUP_LIBRARY=/app/lineups
WORKDIR /app
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/data ./data
COPY --from=build /app/public ./public
# research tables: read by server/sim/nodeData.js as a fallback
COPY --from=build /app/docs/research ./docs/research
# server/http/asset-jump.js imports the edge sidecar's pure functions (one implementation of the whitelist /
# path checks / ?sp_source override — the module says never to copy it), so the file ships even without nginx.
COPY deploy/stardust/ms-edge/edge-sidecar.mjs /app/deploy/stardust/ms-edge/edge-sidecar.mjs

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:3000/healthz" || exit 1
CMD ["node", "server/index.js"]
