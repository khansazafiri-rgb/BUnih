# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# BUnih - citra produksi.
# Dibangun dari akar repositori:
#   docker build -f deploy/Dockerfile -t bunih:latest .
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS pembangun
WORKDIR /app

# better-sqlite3 memakai modul native; sediakan alat bangun bila prebuilt tidak ada.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS jalan
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini sqlite3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    BUNIH_HOST=0.0.0.0 \
    BUNIH_PORT=8787 \
    BUNIH_DATA_DIR=/data \
    TZ=Asia/Jakarta

COPY --from=pembangun /app/node_modules ./node_modules
COPY --from=pembangun /app/package.json ./package.json
COPY --from=pembangun /app/server/package.json ./server/package.json
COPY --from=pembangun /app/server/dist ./server/dist
COPY --from=pembangun /app/web/dist ./web/dist

# Berjalan sebagai pengguna tanpa hak istimewa; volume data dimiliki pengguna ini.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/kesehatan || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
