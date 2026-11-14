# Base image is pinned by digest (multi-arch: amd64 and aarch64), the same one
# Ham Radio Dashboard uses; Dependabot proposes updates.
FROM ghcr.io/home-assistant/base:3.24@sha256:58422480a299b16b6ea376c2167463206d430619ed02b40cd687c8bd6875519e

# Released images are built by .github/workflows/build.yaml, which passes the
# version from config.yaml.
ARG BUILD_VERSION=dev
ENV APP_VERSION=${BUILD_VERSION}
LABEL org.opencontainers.image.source="https://github.com/SWFX2324/swamp-fox-labs-ha-apps"

RUN apk add --no-cache nodejs

COPY app /app
WORKDIR /app

CMD ["node", "/app/server.js"]
