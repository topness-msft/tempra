# syntax=docker/dockerfile:1

# ---- deps: install every workspace dependency once, natives included -------
FROM node:22.11-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY e2e/package.json e2e/
RUN npm ci

# ---- build: compile shared, web and server --------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json vitest.config.ts ./
COPY packages packages
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:22.11-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DB_FILE=tempra.db

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Litestream streams the SQLite WAL to object storage. It is baked in but only
# activated when REPLICA_URL is set, so local runs need no credentials.
ARG LITESTREAM_VERSION=0.3.13
RUN curl -fsSL -o /tmp/ls.deb \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" \
    && dpkg -i /tmp/ls.deb && rm /tmp/ls.deb

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY ops/litestream.yml /etc/litestream.yml
COPY ops/entrypoint.sh /usr/local/bin/entrypoint.sh
# Editing this repo from Windows reintroduces CRLF, which makes the kernel look
# for an interpreter named "/bin/sh\r" and fail with a misleading "no such file
# or directory". Strip it here so the image cannot inherit that bug.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
