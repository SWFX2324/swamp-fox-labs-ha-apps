# Base image is pinned by digest (multi-arch: amd64 and aarch64), the same one
# Ham Radio Dashboard uses; Dependabot proposes updates.
FROM ghcr.io/home-assistant/base:3.24@sha256:880016115f356afc814398e17ba68a7ee66dfc1b4eaef09755ea2c9fa18ea481

# Released images are built by .github/workflows/build.yaml, which passes the
# version from config.yaml.
ARG BUILD_VERSION=dev
ENV APP_VERSION=${BUILD_VERSION}
LABEL org.opencontainers.image.source="https://github.com/SWFX2324/swamp-fox-labs-ha-apps"

RUN apk add --no-cache nodejs

COPY app /app
WORKDIR /app

# Lets the Supervisor's watchdog restart the app if its web server stops
# answering. Node runs it, so it stays inside the AppArmor profile's "node"
# child (which is allowed network access) and needs no wget or curl.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --start-interval=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8099/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "/app/server.js"]
